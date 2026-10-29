# Runbook: failed deployment

Covers a failed or half-applied `az deployment sub` stage (stage 1 infrastructure or stage 2 apps), from the helper scripts or the pipeline.

> Not exercised against a live deployment. See the [honesty note](README.md).

## Symptoms

- `deploy-dev.*` or the pipeline stops with `Deployment '<name>' failed`.
- A Container App or the migration job is `Failed`/provisioning for a long time; resources exist but a module failed.
- Errors such as `RoleAssignmentExists`, `VaultAlreadyExists`, `SkuNotAvailable`, `InsufficientQuota`, `RequestDisallowedByPolicy`, `ServerIsBusy`, `MissingSubscriptionRegistration`, or a message starting with a template guard (see below).

## Impact

- **No data is at risk on a first deployment.** Deployments are declarative and idempotent; a failed stage leaves a partially created environment that you can finish or remove.
- On an existing environment a failed update may leave some modules updated and others not (for example new image, old configuration). The previous revision keeps serving traffic until a new one is ready in Multiple revision mode, so users are usually unaffected unless the failure was in the data layer.

## Detection

The script or pipeline reports it. Everything else is below.

## Triage

1. **Find the top-level error.**

   ```powershell
   az deployment sub show --subscription $sub --name <deployment name> --query "properties.error" -o json
   az deployment sub list --subscription $sub --query "[?properties.provisioningState=='Failed'].{name:name,time:properties.timestamp}" -o table
   ```

2. **Find the failing operation.** Modules are nested deployments in the resource group; ask for failed operations at both levels:

   ```powershell
   az deployment operation sub list --subscription $sub --name <deployment name> --query "[?properties.provisioningState=='Failed'].{type:properties.targetResource.resourceType,name:properties.targetResource.resourceName,msg:properties.statusMessage.error.message}" -o json
   az deployment operation group list --subscription $sub --resource-group $rg --name <module name, for example postgres> --query "[?properties.provisioningState=='Failed'].{type:properties.targetResource.resourceType,name:properties.targetResource.resourceName,msg:properties.statusMessage.error.message}" -o json
   ```

   Module deployment names: `monitoring`, `identity`, `network`, `registry`, `storage`, `postgres`, `search`, `openai`, `redis`, `keyvault`, `rbac`, `rbac-openai-existing`, `containerapps`, `budget`, `alerts`, and `pe-*` for private endpoints.

3. **Match the cause:**

   | Error / message                                                               | Cause                                                                                      | Fix                                                                                                                           |
   | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
   | `administratorPassword must be at least 16 characters ...`                    | Guard: password mode without a (long enough) `CASEGUARD_POSTGRES_ADMIN_PASSWORD`           | Provide the password through the environment                                                                                  |
   | `imageTag is required ...` / `The latest tag is mutable ...`                  | Guard: stage 2 without an immutable tag                                                    | Pass `CASEGUARD_IMAGE_TAG`                                                                                                    |
   | `Set either deployOpenAi or existingOpenAiResourceId` / endpoint required     | Guard: conflicting or incomplete OpenAI parameters                                         | Fix the parameter file                                                                                                        |
   | `... free tier does not support private endpoints` / HA on Burstable          | Guard: impossible combination                                                              | Choose a supported tier                                                                                                       |
   | `MissingSubscriptionRegistration`                                             | Resource provider not registered                                                           | `az provider register --subscription $sub --namespace <name> --wait`                                                          |
   | `VaultAlreadyExists`, name already in use                                     | Soft-deleted Key Vault (or global name collision)                                          | Purge/recover it, or set a new `nameSalt`                                                                                     |
   | `InvalidResourceGroupLocation`                                                | The group exists in another region                                                         | Use the existing region                                                                                                       |
   | `SkuNotAvailable`, `LocationIsOfferRestricted`, `NotAvailableForSubscription` | PostgreSQL / Container Apps / Search SKU or region restriction                             | Change region or SKU; request access                                                                                          |
   | `InsufficientQuota`, `QuotaExceeded`                                          | vCPU, Container Apps cores, Azure OpenAI tokens-per-minute                                 | Request quota or reduce size/capacity                                                                                         |
   | `RoleAssignmentExists`, `PrincipalNotFound`                                   | Replication delay for a new identity, or a stale assignment                                | Wait a minute and re-run                                                                                                      |
   | `AuthorizationFailed` on `roleAssignments/write`                              | The deployer cannot create role assignments                                                | Grant Owner, User Access Administrator or RBAC Administrator                                                                  |
   | Container app: cannot pull image / `ImagePullBackOff`                         | Tag missing in the registry, AcrPull not yet propagated                                    | `az acr repository show-tags --name <acr> --repository caseguard-api`; wait and re-run stage 2                                |
   | Container app: Key Vault reference could not be resolved                      | Secret missing, role not propagated, vault firewall/private endpoint blocking the platform | Check the secret exists and `Key Vault Secrets User` is assigned; with private networking verify the private endpoint and DNS |
   | `ServerIsBusy`, `Conflict` on a PostgreSQL child resource                     | Concurrent server operations                                                               | Re-run; the template serialises them but retries can overlap                                                                  |
   | `RequestDisallowedByPolicy`                                                   | An Azure Policy denies a setting (public access, region, tags, SKU)                        | Change parameters (for example private networking) or request an exemption                                                    |
   | `DeploymentQuotaExceeded`                                                     | 800 deployments in the resource group history                                              | `az deployment group delete` for old ones                                                                                     |
   | Budget module: `Unauthorized` / provider errors                               | Missing Cost Management permission or the `Microsoft.Consumption` provider                 | Grant the role / register the provider                                                                                        |

## Mitigation

- **Do not delete the resource group in a hurry** (especially not an existing environment). Most failures are fixed by correcting the cause and re-running the same stage.
- If a single resource is wedged (`Failed` provisioning state), fix the cause and re-run; if it still fails, delete only that resource with the owner's approval and re-run.
- For a failed **update** of an existing environment, the previous revision still serves traffic; shift nothing until the new revision is healthy.

## Recovery

1. Fix the cause.
2. Run What-If again, then re-run the failed stage with the same parameters and the same image tag.
3. Stage 2 after a stage-1 failure: confirm stage 1 finished (`properties.provisioningState` is `Succeeded`) and the images exist before running it.
4. If the failure was inside a release, decide between fixing forward and [rolling back](rollback-procedure.md).

## Verification

- The deployment shows `Succeeded`; outputs are populated (`az deployment sub show ... --query properties.outputs`).
- Revisions are healthy; the smoke tests in [../DEPLOYMENT.md](../DEPLOYMENT.md#57-post-deploy-smoke-tests) pass.
- What-If against the same parameters shows no unexpected changes.

## Follow-ups

- Add the new failure mode to this table, and to the guards in `main.bicep` if it can be caught earlier.
- Check quota and provider registration _before_ the next deployment; keep a pre-flight checklist per subscription.
- Keep deployments small and What-If'd; never edit resources in the portal without back-porting the change to the templates.
