-- 0001_foundation: application role, immutability trigger functions and the helper that every
-- tenant-owned table uses to switch on row-level security.
--
-- SECURITY MODEL (read before changing anything):
--  * Every tenant-owned table has row-level security ENABLED and FORCED with the policy
--        tenant_id = nullif(current_setting('app.tenant_id', true), '')
--    so a session without the setting sees and writes nothing.
--  * The API opens every tenant-scoped transaction with
--        SET LOCAL ROLE caseguard_app;  SELECT set_config('app.tenant_id', <tenant>, true);
--    caseguard_app is NOLOGIN, owns nothing and only holds the privileges granted per table.
--  * PostgreSQL superusers (and roles with BYPASSRLS) bypass row-level security even when it is
--    forced. Production MUST connect as a non-superuser that is a member of caseguard_app. PGlite
--    always runs as a superuser, which is why the role switch above is mandatory in every
--    tenant-scoped transaction.
--  * Portable SQL: runs on PGlite (PostgreSQL 18) and PostgreSQL 16. Nothing here depends on
--    features newer than 16.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caseguard_app') THEN
    CREATE ROLE caseguard_app NOLOGIN;
  END IF;
END
$$;

-- The migrating/connecting role must be allowed to SET ROLE caseguard_app. Role creators receive
-- ADMIN OPTION automatically on PostgreSQL 16+, which is enough to grant membership to themselves.
-- Deployments where a DBA pre-created the role grant membership to the API login role instead.
DO $$
BEGIN
  GRANT caseguard_app TO CURRENT_USER;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not grant caseguard_app to the migrating role; grant it to the API login role manually.';
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO caseguard_app', current_schema());
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not grant USAGE on schema %; the role may already have it through PUBLIC.', current_schema();
END
$$;

-- Immutability for case source/event/resolution rows. UPDATE is never allowed. DELETE is allowed
-- only while the transaction has set app.allow_erasure = 'on', which CaseRepository.delete and the
-- demo reset do for the duration of one statement. The setting is a guard against accidents and
-- application bugs, not against someone who can run arbitrary SQL as caseguard_app; the privilege
-- grants below additionally keep direct DELETE/UPDATE on these tables away from that role.
CREATE OR REPLACE FUNCTION caseguard_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.allow_erasure', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'immutable record: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'CG001';
END
$$;

-- Audit events can never be updated or deleted, with or without the erasure setting.
CREATE OR REPLACE FUNCTION caseguard_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'CG001';
END
$$;

-- Enables and forces row-level security with the tenant policy and grants the application role
-- exactly the listed privileges. Every migration that creates a tenant-owned table calls this.
CREATE OR REPLACE FUNCTION caseguard_secure_tenant_table(
  p_table text,
  p_privileges text,
  p_column text DEFAULT 'tenant_id'
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_privileges !~ '^[a-z]+(, [a-z]+)*$' THEN
    RAISE EXCEPTION 'invalid privilege list: %', p_privileges;
  END IF;
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I '
    'USING (%I = nullif(current_setting(''app.tenant_id'', true), '''')) '
    'WITH CHECK (%I = nullif(current_setting(''app.tenant_id'', true), ''''))',
    p_table, p_column, p_column);
  EXECUTE format('REVOKE ALL ON %I FROM caseguard_app', p_table);
  EXECUTE format('GRANT %s ON %I TO caseguard_app', p_privileges, p_table);
END
$$;

REVOKE ALL ON FUNCTION caseguard_secure_tenant_table(text, text, text) FROM PUBLIC;
