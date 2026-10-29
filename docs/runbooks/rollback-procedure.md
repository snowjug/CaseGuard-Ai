# Runbook: rollback procedure

Three kinds of rollback, from cheapest to most expensive: **application** (previous revision), **infrastructure** (previous template state) and **database** (restore). Prefer the cheapest that restores service.

> Not exercised against a live deployment. See the [honesty note](README.md). Rollback depends on design choices that must hold for it to work: Multiple revision mode (set by the templates), `maxInactiveRevisions` of 5 (older revisions are pruned), immutable image tags, and **backward-compatible migrations**.

## When to roll back

Roll back, rather than debug in production, when after a release any of these holds and a quick fix is not obvious:

- the smoke tests fail, or the new revision is unhealthy (`az containerapp revision list` shows health problems);
- the API 5xx rate or latency alert fires and correlates with the release (OBSERVABILITY 4.1, 4.2);
- a security or data-integrity defect is discovered in the release.

Decide within minutes, record the decision and the time, and tell users.

## Application rollback

The apps keep several revisions; each new revision receives 100% of traffic once ready, and the previous one stays available.

1. **Find the revisions.**

   ```powershell
   az containerapp revision list --subscription $sub --resource-group $rg --name <api app> `
     --query "[].{revision:name,created:properties.createdTime,active:properties.active,traffic:properties.trafficWeight,health:properties.healthState,image:properties.template.containers[0].image}" -o table
   ```

2. **Re-activate the previous revision** if it was deactivated (a revision that is inactive keeps its history but runs nothing):

   ```powershell
   az containerapp revision activate --subscription $sub --resource-group $rg --name <api app> --revision <previous revision>
   ```

3. **Shift all traffic to it:**

   ```powershell
   az containerapp ingress traffic set --subscription $sub --resource-group $rg --name <api app> --revision-weight <previous revision>=100
   ```

4. **Deactivate the bad revision** (stops its replicas and cost): `az containerapp revision deactivate ... --revision <bad revision>`.
5. **Repeat for the web app** if the release changed both. Mind the coupling: the web image has the API URL and `NEXT_PUBLIC_*` baked in at build time and calls the API's `/api/*` routes, so web and API contracts must stay compatible across the pair you leave running.
6. **Scale-to-zero note:** if `minReplicas` is 0 the previous revision starts on the first request; expect a cold start.

**Durable rollback.** Traffic shifting is an operational override. The next deployment resets traffic to the latest revision (the template sets `latestRevision` to 100%). To make a rollback durable, re-run stage 2 with the **previous immutable tag**:

```powershell
$env:CASEGUARD_DEPLOY_APPS = 'true'; $env:CASEGUARD_IMAGE_TAG = '<previous tag>'
az deployment sub create --subscription $sub --location <region> --name caseguard-rollback --parameters infra/bicep/main.<env>.local.bicepparam
```

This creates a **new** revision from the old image (slower than reactivating, but declarative and visible to What-If). In production this goes through the same approvals as a release, except that the pipeline may support an expedited path: agree it beforehand.

## Migrations and the database

- Migrations are **forward-only**. Rolling back the application does not roll back the schema; this works only if the previous code runs on the new schema (expand/contract: add before use, remove only in a later release).
- If the previous code is **incompatible** with the new schema, you cannot simply shift traffic. Options: fix forward (preferred), or restore the database to just before the migration (point-in-time restore creates a new server; data written after the restore point is lost). See [broken-migration](broken-migration.md) and [database-unavailable](database-unavailable.md#recovery).
- Record the time before every production migration job; it is the restore point.

## Infrastructure rollback

1. Identify the change: the Git history of `infra/`, the deployment that introduced it (`az deployment sub list`), and What-If output.
2. Check out the **previous commit's** templates and parameter file, run What-If against the environment, review every difference, and deploy. Deployments are declarative: the result is the previous desired state, not an undo of side effects.
3. **Some changes are one-way or have side effects** - plan for them:

   | Change                                                | Rolling back...                                                                                  |
   | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
   | Key Vault purge protection enabled                    | cannot be disabled once on                                                                       |
   | PostgreSQL storage growth                             | storage cannot shrink                                                                            |
   | PostgreSQL SKU/tier/HA/version change                 | may restart the server; major version upgrades cannot be reverted in place                       |
   | Soft-deleted names (Key Vault, OpenAI, Log Analytics) | names stay reserved; use a new `nameSalt` or purge                                               |
   | Role assignments removed then re-added                | new assignment ids; propagation delay of minutes                                                 |
   | Private networking turned on/off                      | changes endpoint reachability for every client; the PostgreSQL network mode is fixed at creation |
   | Storage lifecycle deletion already ran                | deleted blobs are recoverable only within the soft-delete window                                 |

4. For secrets rotated as part of the change, see [secret-exposure-response](secret-exposure-response.md); Key Vault keeps previous versions (`az keyvault secret list-versions`), but never restore a secret that was exposed.

## Verification

- `az containerapp revision list` shows the intended revision active with 100% traffic and healthy.
- Smoke tests pass ([../DEPLOYMENT.md](../DEPLOYMENT.md#57-post-deploy-smoke-tests)); error rate and latency return to baseline (OBSERVABILITY 4.1, 4.2).
- `GET /api/v1/system/health` shows migrations in the expected state.
- What-If against the rolled-back parameters shows no unexpected drift (apart from the traffic override, if you did not make the rollback durable).

## Follow-ups

- Post-incident review: why was the defect not caught (tests, What-If, canary), and what would have made rollback faster.
- Make rollback a rehearsed step of every release: practise it in dev once per release train.
- Consider label-based canary routing (`ingress.traffic` with revision labels and a small weight) for risky releases.
- Keep the previous N tags in the registry (do not purge them aggressively; see the purge note in [../COST_GUIDE.md](../COST_GUIDE.md)).
