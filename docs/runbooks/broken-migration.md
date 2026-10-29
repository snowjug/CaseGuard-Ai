# Runbook: broken migration

Covers the `migrate` Container Apps job (`node dist/db/migrate-cli.js`) failing, hanging or leaving the schema in a state the code does not expect.

> Not exercised against a live deployment. See the [honesty note](README.md). Whether each migration runs in its own transaction is an implementation detail of the API's migration runner that this document does not assume: check it before relying on automatic rollback of a failed migration.

## Symptoms

- The job execution ends `Failed`, `Degraded` or `Stopped`, or exceeds `migrationTimeoutSeconds` (default 900 s).
- `/readyz` fails after a release because migrations are pending (`/api/v1/system/health` reports `migrations.pending` above zero), or the API logs `relation ... does not exist` / `column ... does not exist` / constraint or RLS errors.
- A new revision never becomes ready although the previous one is healthy.

## Impact

- With **pending** migrations: the new API revision is not ready; if traffic was already shifted to it, users get 503s (shift traffic back, see Mitigation).
- With a **partially applied or wrong** migration: runtime errors on affected routes, possible data integrity issues, and in the worst case destructive data loss.
- Migrations run only through this job (`DB_AUTO_MIGRATE=false` in Azure), one replica, no automatic retry, so there is no concurrent-migration race.

## Detection

- Job status: `az containerapp job execution list --subscription $sub --resource-group $rg --name <migrate job> -o table`.
- Job output (the job logs `caseguard-migrate`):

  ```kusto
  union isfuzzy = true
      (ContainerAppConsoleLogs | project TimeGenerated, Raw = Log),
      (ContainerAppConsoleLogs_CL | project TimeGenerated, Raw = Log_s)
  | where TimeGenerated > ago(2h) and Raw has 'caseguard-migrate'
  | project TimeGenerated, Raw
  | order by TimeGenerated asc
  ```

- Readiness failures on the latest revision (OBSERVABILITY 4.10); `GET /api/v1/system/health` (permission `telemetry:read`) shows applied/pending/latest migration.

## Triage

1. **Which migration failed and why?** Read the job output to the first error: SQL error text, lock timeout, permission denied, `extension ... is not allow-listed`, out of disk, statement timeout, or the runner's own validation.
2. **What state is the database in?** Connect as an administrator (dev: the password from Key Vault `postgres-admin-password`; Entra mode: a member of the Entra administrator group with an access token as the password) and inspect the migration bookkeeping table and the objects the failed migration touches. If the migration was transactional the schema is unchanged; if it used statements that cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`) or several steps, it may be partially applied.
3. **Common causes:**
   - **Extension not allow-listed** - add it to `postgresAllowedExtensions` and redeploy stage 1, then re-run the job.
   - **Permissions** - the migration role must own the objects; in Entra mode the identity is the administrator, in dev the `cgadmin` login.
   - **Locks** - another session holds locks (`pg_stat_activity`, `pg_locks`): a still-running old revision, a long query, or a stuck previous job execution.
   - **Timeout** - a long migration on a small SKU; raise `migrationTimeoutSeconds` or scale the database temporarily.
   - **Code and schema disagree** - the image runs migrations it does not contain (wrong tag) or an older image than the schema: compare the image tag of the job and the revision.
4. **Is it safe to retry?** Only if the failure was transient and the migration is idempotent or fully rolled back. Retrying a half-applied non-transactional migration can make things worse.

## Mitigation

1. **Protect users first.** If the new revision is not ready, shift traffic back to the previous revision (commands in [rollback-procedure](rollback-procedure.md#application-rollback)). This works only while the previous code is compatible with the current schema, which is why migrations must be backward compatible (expand, then contract in a later release).
2. **Stop making it worse.** Do not re-run the job repeatedly, do not edit an already-applied migration file, and do not "fix" production by hand-editing the bookkeeping table without a recorded plan.
3. **Decide the path** with the data owner:
   - _Transient cause (lock, timeout, disk):_ fix it and re-run the job once.
   - _Migration bug, schema unchanged:_ fix forward - add a **new** corrective migration, build and push a new image, deploy stage 2, run the job.
   - _Migration bug, schema partially changed:_ write a compensating migration that brings the schema to the intended state, review it on a restored copy first, then apply.
   - _Data damaged or destructive migration gone wrong:_ point-in-time restore to just before the job started (data written since is lost) - see [database-unavailable](database-unavailable.md#recovery). Record the job start time **before** every production migration so this is possible.

## Recovery

- Apply the chosen fix, then re-run the job: `az containerapp job start --subscription $sub --resource-group $rg --name <migrate job>`.
- Wait for `Succeeded`; confirm the API readiness recovers on its own (probes), restarting the revision only if it does not.
- If you rolled traffic back, shift it to the fixed revision only after verification.

## Verification

- Job execution `Succeeded`; `migrations.pending` is 0 and `latest` is the expected migration (`GET /api/v1/system/health`).
- `/readyz` returns 200 inside the container; the smoke tests in [../DEPLOYMENT.md](../DEPLOYMENT.md#57-post-deploy-smoke-tests) pass.
- Row-level security still enforces tenant isolation (a user of one tenant cannot read another tenant's rows) - the table owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set, and managed-PostgreSQL parity is unverified (docs/THREAT_MODEL.md section 5).

## Follow-ups

- Rehearse every migration on a restored copy of the target database before production.
- Adopt expand/contract and keep each release's schema compatible with the previous release's code.
- Run the integration suite against real PostgreSQL in CI (it exists); add a CI check for migrations that need `postgresAllowedExtensions`.
- Take (and note the time of) a manual restore point before risky migrations; test restores.
- Consider a separate migration identity from the runtime identity so the runtime role cannot alter the schema and RLS cannot be bypassed as table owner.
