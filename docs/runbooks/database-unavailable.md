# Runbook: database unavailable

> Not exercised against a live deployment. See the [honesty note](README.md).

## Symptoms

- `/readyz` returns 503 (the readiness check covers the database **and** applied migrations); the revision shows unhealthy or users get 503/504 from the web app's `/api/*` proxy.
- API logs show `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `password authentication failed`, `no pg_hba.conf entry`, `SSL`/TLS errors, `too many connections`, `remaining connection slots are reserved`, `cannot execute ... in a read-only transaction`, or Microsoft Entra token errors.
- Metrics: `connections_failed` rising, `active_connections` at the limit, `storage_percent` at 100, `cpu_percent` pinned.

## Impact

- **Every data-dependent route fails.** The web UI loads, but cases, ledgers, skills, audit and analytics are unavailable. Severity 1 in production.
- No data is lost by an outage itself. Data loss risk exists only when storage is exhausted, a bad migration ran, or a restore is needed.
- Writes in flight when the failure began may have failed; clients should retry (writes are designed to be idempotent).

## Detection

- API 5xx alert; readiness failures on the latest revision (`ContainerAppSystemLogs`, OBSERVABILITY 4.10); PostgreSQL metrics query in OBSERVABILITY 4.10; Azure Service Health.
- Logs:

  ```kusto
  CgApiLogs()
  | where TimeGenerated > ago(30m) and level >= 50 and (msg has_any ('ECONN', 'ETIMEDOUT', 'ENOTFOUND', 'password authentication', 'too many connections', 'read-only transaction', 'SSL', 'readyz'))
  | summarize occurrences = count(), sampleCorrelationId = take_any(correlationId) by msg
  | order by occurrences desc
  ```

## Triage

Work from the outside in; stop at the first failing step.

1. **Server state.**

   ```powershell
   az postgres flexible-server show --subscription $sub --resource-group $rg --name <server> --query "{state:state,ha:highAvailability.state,sku:sku.name,storageGb:storage.storageSizeGb,publicAccess:network.publicNetworkAccess}" -o table
   ```

   `Stopped` (dev databases are often stopped to save cost, and Azure restarts a stopped server after a limited time): `az postgres flexible-server start ...`. `Updating`/`Starting`: wait. HA failover in progress: wait, then verify.

2. **Network path.**
   - Public mode (dev): the `AllowAzureServices` (`0.0.0.0`) rule or your explicit rules must exist: `az postgres flexible-server firewall-rule list ... -o table`. A closed firewall (the default) blocks the apps by design.
   - Private endpoint mode (staging/prod): the private endpoint connection must be `Approved`; the zone `privatelink.postgres.database.azure.com` must be linked to the VNet; from the API container `nslookup <server>.postgres.database.azure.com` must return a private address (`az containerapp exec`).
3. **Authentication.**
   - **Password mode (dev):** the `database-url` Key Vault secret must match the server password. A rotated password with an un-restarted revision fails with `password authentication failed`. Compare secret versions: `az keyvault secret list-versions --vault-name <kv> --name database-url -o table`; restart revisions after a rotation.
   - **Entra mode (staging/prod):** the managed identity must be an Entra administrator of the server (`az postgres flexible-server ad-admin list ...`), the container must have `AZURE_CLIENT_ID` set, and `DATABASE_AUTH=entra`. Token errors usually mean the identity was recreated (new principal id): redeploy so the administrator registration is updated.
4. **Capacity.**
   - Connections: replicas x `DB_POOL_MAX` must stay below the server limit (small Burstable SKUs have a low limit). Scale the API down or lower `databasePoolMax`.
   - Storage full puts the server into read-only mode. Grow storage (auto-grow is enabled by the template, but confirm): `az postgres flexible-server update --subscription $sub --resource-group $rg --name <server> --storage-size <GB>`.
   - CPU/credits: a Burstable SKU out of credits throttles hard; scale up the SKU.
5. **Schema.** Everything connects but `/readyz` still fails: migrations pending or failed. Go to [broken-migration](broken-migration.md).
6. **Azure-side event.** Planned maintenance, failover or an incident: Activity Log and Service Health.

## Mitigation

- Start the server, repair the firewall/DNS/private endpoint, fix the credential or administrator registration, or grow storage/scale the SKU as found above.
- Relieve connection pressure: reduce `apiMaxReplicas`/`databasePoolMax`, restart the API revision: `az containerapp revision restart --subscription $sub --resource-group $rg --name <api app> --revision <revision>`.
- During a prolonged outage, tell users and keep the web app up; do not disable authentication or point the API at another database to "get it working".

## Recovery

- **Transient or configuration fault:** restart the revision once the server is healthy; no data action needed.
- **Corruption, bad migration or accidental deletion:** point-in-time restore. This creates a **new server**:

  ```powershell
  az postgres flexible-server restore --subscription $sub --resource-group $rg --name <new-server-name> --source-server <server> --restore-time "<UTC ISO-8601 time just before the incident>"
  ```

  Validate the restored data, then repoint the application (update the `database-url` secret in password mode, or the server name used by `DATABASE_URL` in Entra mode, and register the identity as administrator on the new server). Because template names are deterministic, adopting a restored server means either changing `nameSalt` (new names for everything) or restoring over the old name after deleting the original; plan this, and treat data written after the restore point as lost. Do not do it during an incident without the data owner's approval.

- **Region-level failure:** there is no automated disaster-recovery in these templates (geo-redundant backup is an option, `postgresGeoRedundantBackup`). Recovery would be a restore in another region plus a new deployment: document your RTO/RPO accordingly.

## Verification

- `az postgres flexible-server show ... --query state` is `Ready`.
- `/readyz` returns 200 from inside the container, the latest revision is healthy, and `node scripts/smoke-test.mjs --web https://<web fqdn> --auth enforced` passes.
- Query 4.2 shows 5xx back to baseline; PostgreSQL metrics show connections and storage within limits.
- After a restore: spot-check tenant isolation (a user of one tenant cannot read another's cases) because row-level security parity on managed PostgreSQL has not been verified (docs/THREAT_MODEL.md section 5).

## Follow-ups

- Alerts on `active_connections`, `storage_percent`, `connections_failed` and server state; add them to the monitoring set.
- Size the pool (`databasePoolMax`) against replicas and the SKU limit; consider a pooler if replicas grow.
- Production: zone-redundant HA (`postgresHighAvailability`), longer backup retention, and a **tested** restore procedure (restore to a scratch server quarterly).
- Keep migrations backward compatible so a rollback does not depend on a restore (see [rollback-procedure](rollback-procedure.md)).
