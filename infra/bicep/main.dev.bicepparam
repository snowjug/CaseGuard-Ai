using 'main.bicep'

// =====================================================================================================================
// CaseGuard AI - DEVELOPMENT parameters. Smallest SKUs, scale to zero, optional services off, no private networking.
//
// This file is a template with obvious placeholder values (all-zero GUIDs, CHANGE_ME strings, an example mail domain). It builds as-is, but the
// helper scripts refuse to deploy while a placeholder remains. Copy it to main.dev.local.bicepparam (git-ignored),
// fill in your values there, and deploy that copy. Never commit real tenant, subscription or app ids.
// Region is NOT set here: pass it with the deployment location (see infra/scripts and docs/DEPLOYMENT.md).
// =====================================================================================================================

param environmentName = 'dev'

// Tags (docs: infra/bicep/README.md#tags)
param owner = 'CHANGE-ME-team-alias'
param costCenter = 'CHANGE-ME'

// Two-stage deployment. The scripts set these environment variables; the defaults deploy infrastructure only.
//   stage 1: CASEGUARD_DEPLOY_APPS unset/false -> everything except the Container Apps and the migration job
//   stage 2: CASEGUARD_DEPLOY_APPS=true and CASEGUARD_IMAGE_TAG set to the immutable tag pushed to the registry
param deployContainerApps = bool(readEnvironmentVariable('CASEGUARD_DEPLOY_APPS', 'false'))
param imageTag = readEnvironmentVariable('CASEGUARD_IMAGE_TAG', '')

// Scale to zero: no idle compute cost, first request after idle waits for a cold start.
param webMinReplicas = 0
param webMaxReplicas = 2
param apiMinReplicas = 0
param apiMaxReplicas = 2

// Optional: restrict who can reach the web app while this is a dev environment, for example ['203.0.113.10/32'].
param webAllowedIpRanges = []

// Microsoft Entra ID. See docs/ENTRA_ID_SETUP.md. Azure environments never use persona login.
// entraApiAudience must equal the aud claim of the access tokens: the API client id for v2 tokens, api:// plus the client id for v1.
param entraTenantId = '00000000-0000-0000-0000-000000000000'
param entraApiAudience = 'api://00000000-0000-0000-0000-000000000000'
param entraWebClientId = '00000000-0000-0000-0000-000000000000'
param entraApiScope = 'api://00000000-0000-0000-0000-000000000000/access_as_user'
param entraTenantMap = {
  '00000000-0000-0000-0000-000000000000': 'tenant_contoso_support'
}

// Demo data routes are allowed in dev only; seeding on every start stays off.
param demoMode = true
param demoAutoSeed = false

// Database: Burstable, password authentication. The password comes from the environment and is stored in Key Vault by
// the template. It is never written to this file or to the command line. Minimum 16 characters.
param postgresAuthMode = 'password'
param postgresSkuTier = 'Burstable'
param postgresSkuName = 'Standard_B1ms'
param postgresStorageGb = 32
param postgresBackupRetentionDays = 7
param postgresHighAvailability = 'Disabled'
param postgresAdminPassword = readEnvironmentVariable('CASEGUARD_POSTGRES_ADMIN_PASSWORD', '')
// DEV ONLY. Container Apps has no stable outbound IP without a VNet, so the server must accept connections from any
// Azure-hosted client (authentication and TLS are still required). Use enablePrivateNetworking for anything else.
param postgresAllowAzureServices = true

// Storage and secrets: synthetic data only, so blobs expire; the vault can be purged to allow quick re-deployment.
param storageSku = 'Standard_LRS'
param blobCoolAfterDays = 0
param blobDeleteAfterDays = 30
param keyVaultSoftDeleteDays = 7
param keyVaultPurgeProtection = false
param registrySku = 'Basic'

// Observability with a cost ceiling: the cap stops ingestion for the rest of the UTC day when reached.
param logRetentionDays = 30
param logDailyCapGb = 1
param diagnosticsEnabled = true
param containerAppsHttpLogs = false

// Optional services stay off in dev.
param deploySearch = false
param deployOpenAi = false
param deployRedis = false
param enablePrivateNetworking = false

// Budget and alerts. The amount is a notification threshold in your billing currency, not an estimate.
param monthlyBudgetAmount = 100
param contactEmails = [
  'owner@example.com'
]
param deployAlerts = false
