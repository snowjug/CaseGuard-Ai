-- 0002_tenancy: tenants, users, governance settings and prompt versions.
--
-- Conventions used by every tenant-owned table in this schema:
--   * tenant_id text NOT NULL, part of the primary key and of every composite foreign key;
--   * relational columns for filter/sort/join keys PLUS data jsonb holding the full entity that the
--     application validated with its Zod schema (reads re-validate it before returning);
--   * timestamps are timestamptz written with millisecond precision (so keyset cursors round-trip);
--   * integer / double precision only (no bigint, no numeric) so drivers return plain numbers.

CREATE TABLE tenants (
  id         text        PRIMARY KEY,
  name       text        NOT NULL,
  slug       text        NOT NULL,
  synthetic  boolean     NOT NULL,
  created_at timestamptz NOT NULL,
  data       jsonb       NOT NULL,
  CONSTRAINT tenants_slug_uq UNIQUE (slug)
);

CREATE TABLE users (
  tenant_id    text        NOT NULL REFERENCES tenants (id),
  id           text        NOT NULL,
  display_name text        NOT NULL,
  email        text        NOT NULL,
  roles        text[]      NOT NULL,
  status       text        NOT NULL,
  synthetic    boolean     NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  created_by   text        NOT NULL,
  version      integer     NOT NULL DEFAULT 1,
  data         jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT users_version_chk CHECK (version >= 1),
  CONSTRAINT users_roles_chk CHECK (cardinality(roles) >= 1)
);

-- One account per e-mail address inside a tenant (identity providers map by e-mail).
CREATE UNIQUE INDEX users_tenant_email_uq ON users (tenant_id, lower(email));

CREATE TABLE governance_settings (
  tenant_id   text        NOT NULL REFERENCES tenants (id),
  section     text        NOT NULL,
  value       jsonb       NOT NULL,
  version     integer     NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL,
  updated_by  text        NOT NULL,
  change_note text        NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, section),
  CONSTRAINT governance_settings_version_chk CHECK (version >= 1)
);

CREATE TABLE prompt_versions (
  tenant_id     text        NOT NULL REFERENCES tenants (id),
  id            text        NOT NULL,
  agent         text        NOT NULL,
  semver        text        NOT NULL,
  template_hash text        NOT NULL,
  status        text        NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  created_by    text        NOT NULL,
  data          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- A prompt agent has exactly one record per template version number.
CREATE UNIQUE INDEX prompt_versions_agent_semver_uq ON prompt_versions (tenant_id, agent, semver);

-- Tenants are provisioned out of band (seed/migration): the application role may only read them.
SELECT caseguard_secure_tenant_table('tenants', 'select', 'id');
SELECT caseguard_secure_tenant_table('users', 'select, update');
SELECT caseguard_secure_tenant_table('governance_settings', 'select, insert, update');
SELECT caseguard_secure_tenant_table('prompt_versions', 'select, insert, update');
