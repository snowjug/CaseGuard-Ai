// CaseGuard AI - Azure infrastructure (subscription scope).
//
// Creates the resource group and deploys every module into it. Nothing in this repository has been deployed:
// see docs/DEPLOYMENT.md for what is and is not validated, and run what-if before the first real deployment.
//
// Naming: <abbr>-<workload>-<env>-<suffix>, where env is dev|stg|prd and suffix is six characters derived from the
// subscription id (override the seed with nameSalt). Globally unique names that forbid hyphens drop them
// (cr<workload><env><suffix>, st<workload><env><suffix>). The resource group is rg-<workload>-<env> without suffix.
//
// Two-stage first deployment: deployContainerApps=false creates everything except the apps and the job (the registry
// is empty at that point); after the images are pushed, deploy again with deployContainerApps=true and imageTag.

targetScope = 'subscription'

// ---------------------------------------------------------------------------------------------------------------
// Identity of the deployment
// ---------------------------------------------------------------------------------------------------------------

@description('Deployment environment. Drives naming, the application environment (development/staging/production) and defaults.')
@allowed([
  'dev'
  'staging'
  'prod'
])
param environmentName string

@description('Azure region for the resource group and all resources. SKU, quota and model availability differ per region; see docs/DEPLOYMENT.md.')
param location string = deployment().location

@description('Short workload name used in resource names: 3-9 lowercase letters or digits (longer names exceed the Key Vault and Container Apps job name limits).')
@minLength(3)
@maxLength(9)
param workloadName string = 'caseguard'

@description('Optional salt that changes the generated unique suffix. Use it to get fresh globally unique names, for example after a deleted Key Vault name is still reserved by soft delete.')
param nameSalt string = ''

@description('Owner tag: a team alias or accountable person. Avoid personal e-mail addresses if tags are exported widely.')
@minLength(1)
param owner string

@description('Cost center tag used for chargeback reports.')
@minLength(1)
param costCenter string

// ---------------------------------------------------------------------------------------------------------------
// Container Apps (web, api, migrate job)
// ---------------------------------------------------------------------------------------------------------------

@description('Deploy the Container Apps and the migration job. Set false for the first stage, before images exist in the registry.')
param deployContainerApps bool = true

@description('Image tag for both images. Required when deployContainerApps is true. Use an immutable tag (commit SHA or version); latest is rejected in prod.')
param imageTag string = ''

@description('Repository name of the web image in the registry.')
param webImageRepository string = 'caseguard-web'

@description('Repository name of the API image in the registry (also runs the migration job).')
param apiImageRepository string = 'caseguard-api'

@description('vCPU of the web app. Pair with a matching memory value.')
@allowed([
  '0.25'
  '0.5'
  '0.75'
  '1.0'
  '1.25'
  '1.5'
  '1.75'
  '2.0'
])
param webCpu string = '0.25'

@description('Memory of the web app, for example 0.5Gi for 0.25 vCPU.')
@allowed([
  '0.5Gi'
  '1.0Gi'
  '1.5Gi'
  '2.0Gi'
  '2.5Gi'
  '3.0Gi'
  '3.5Gi'
  '4.0Gi'
])
param webMemory string = '0.5Gi'

@description('Minimum web replicas. 0 scales to zero: no idle cost, but the first request waits for a cold start.')
@minValue(0)
param webMinReplicas int = 0

@description('Maximum web replicas.')
@minValue(1)
param webMaxReplicas int = 2

@description('Concurrent requests per web replica that trigger scale-out.')
@minValue(1)
param webConcurrentRequests int = 50

@description('vCPU of the API. Pair with a matching memory value.')
@allowed([
  '0.25'
  '0.5'
  '0.75'
  '1.0'
  '1.25'
  '1.5'
  '1.75'
  '2.0'
])
param apiCpu string = '0.5'

@description('Memory of the API, for example 1.0Gi for 0.5 vCPU.')
@allowed([
  '0.5Gi'
  '1.0Gi'
  '1.5Gi'
  '2.0Gi'
  '2.5Gi'
  '3.0Gi'
  '3.5Gi'
  '4.0Gi'
])
param apiMemory string = '1.0Gi'

@description('Minimum API replicas. 0 scales to zero. Rate limits and caches are per replica, so keep the maximum low until a shared store exists.')
@minValue(0)
param apiMinReplicas int = 0

@description('Maximum API replicas.')
@minValue(1)
param apiMaxReplicas int = 2

@description('Concurrent requests per API replica that trigger scale-out.')
@minValue(1)
param apiConcurrentRequests int = 20

@description('IP ranges (CIDR or single IP) allowed to reach the web app. Empty allows any client. Non-empty denies everything else, useful for a locked-down dev environment.')
param webAllowedIpRanges array = []

@description('Spread the Container Apps environment over availability zones. Requires enablePrivateNetworking and a zone-enabled region.')
param containerAppsZoneRedundant bool = false

@description('Maximum run time of the migration job in seconds.')
@minValue(60)
@maxValue(3600)
param migrationTimeoutSeconds int = 900

// ---------------------------------------------------------------------------------------------------------------
// Application configuration (environment-variable contract)
// ---------------------------------------------------------------------------------------------------------------

@description('Version string reported as APP_VERSION. Empty falls back to imageTag.')
param appVersion string = ''

@description('Git commit reported as GIT_COMMIT. Empty omits the variable.')
param gitCommit string = ''

@description('Application log level.')
@allowed([
  'trace'
  'debug'
  'info'
  'warn'
  'error'
  'fatal'
])
param logLevel string = 'info'

@description('Microsoft Entra tenant id used to validate tokens. See docs/ENTRA_ID_SETUP.md.')
param entraTenantId string

@description('Expected audience (aud claim) of access tokens, ENTRA_AUDIENCE. With v2 access tokens (requestedAccessTokenVersion 2) this is the API app registration client id; with v1 tokens it is the Application ID URI api://<client-id>. Decode a real token to confirm. See docs/ENTRA_ID_SETUP.md.')
param entraApiAudience string

@description('Client id of the SPA/web app registration (NEXT_PUBLIC_ENTRA_CLIENT_ID).')
param entraWebClientId string

@description('API scope the SPA requests (NEXT_PUBLIC_ENTRA_API_SCOPE), for example api://<api-client-id>/access_as_user.')
param entraApiScope string

@description('Maps an Entra tenant id to a CaseGuard tenant id (ENTRA_TENANT_MAP), for example { "<entra tid>": "tenant_contoso_support" }.')
param entraTenantMap object

@description('Maps Entra app role values to CaseGuard roles (ENTRA_ROLE_MAP).')
param entraRoleMap object = {
  'CaseGuard.Engineer': 'engineer'
  'CaseGuard.Reviewer': 'reviewer'
  'CaseGuard.Manager': 'manager'
  'CaseGuard.SkillCurator': 'skill_curator'
  'CaseGuard.Administrator': 'administrator'
}

@description('Enable the demo seed/reset routes (DEMO_MODE). Defaults to on only for dev. Must be false in production.')
param demoMode bool = environmentName == 'dev'

@description('Seed synthetic data on every API start (DEMO_AUTO_SEED). Off by default: scale-to-zero restarts would re-run it.')
param demoAutoSeed bool = false

@description('Maximum PostgreSQL connections per replica (DB_POOL_MAX). Keep replicas x pool below the server connection limit.')
@minValue(1)
param databasePoolMax int = 5

@description('Maximum prompt tokens per model call (AI_MAX_INPUT_TOKENS).')
@minValue(1)
param aiMaxInputTokens int = 24000

@description('Maximum completion tokens per model call (AI_MAX_OUTPUT_TOKENS).')
@minValue(1)
param aiMaxOutputTokens int = 4000

@description('Model call timeout in milliseconds (AI_TIMEOUT_MS).')
@minValue(1000)
param aiTimeoutMs int = 30000

@description('Model call retries (AI_MAX_RETRIES).')
@minValue(0)
param aiMaxRetries int = 2

@description('Daily spend limit enforced by the application token governor, as a decimal string in USD (AI_COST_LIMIT_USD_PER_DAY). Empty means no application-level limit.')
param aiCostLimitUsdPerDay string = ''

@description('Operator-supplied price per 1,000 input tokens for cost estimates (AI_UNIT_PRICE_INPUT_PER_1K). Empty reports cost as unknown. Never hard-coded: look up the current price for your deployment.')
param aiUnitPriceInputPer1k string = ''

@description('Operator-supplied price per 1,000 output tokens (AI_UNIT_PRICE_OUTPUT_PER_1K). Empty reports cost as unknown.')
param aiUnitPriceOutputPer1k string = ''

@description('OpenTelemetry trace sampling ratio between 0 and 1 (OTEL_SAMPLING_RATIO). Lower values reduce telemetry cost.')
param otelSamplingRatio string = '1'

// ---------------------------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------------------------

@description('PostgreSQL authentication: password (dev) or entra (Entra-only, recommended for staging and prod).')
@allowed([
  'password'
  'entra'
])
param postgresAuthMode string = environmentName == 'dev' ? 'password' : 'entra'

@description('PostgreSQL administrator login for password mode.')
param postgresAdminLogin string = 'cgadmin'

@description('PostgreSQL administrator password for password mode (16+ characters). Stored in Key Vault by this template. Never put it in a parameter file: supply it through the environment (see docs/DEPLOYMENT.md).')
@secure()
param postgresAdminPassword string = ''

@description('PostgreSQL compute tier.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresSkuTier string = 'Burstable'

@description('PostgreSQL compute SKU matching the tier. Verify availability in your region and subscription.')
param postgresSkuName string = 'Standard_B1ms'

@description('PostgreSQL major version.')
@allowed([
  '15'
  '16'
  '17'
])
param postgresVersion string = '16'

@description('PostgreSQL storage in GB.')
@minValue(32)
param postgresStorageGb int = 32

@description('Backup retention in days.')
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7

@description('Geo-redundant PostgreSQL backups.')
param postgresGeoRedundantBackup bool = false

@description('PostgreSQL high availability. Requires GeneralPurpose or MemoryOptimized.')
@allowed([
  'Disabled'
  'SameZone'
  'ZoneRedundant'
])
param postgresHighAvailability string = 'Disabled'

@description('DEV ONLY: open the PostgreSQL firewall to every Azure-hosted client (the 0.0.0.0 rule). Required without private networking because Container Apps has no stable outbound IP. Leave false for staging and prod.')
param postgresAllowAzureServices bool = false

@description('Explicit public PostgreSQL firewall rules: { name, startIpAddress, endIpAddress }. Ignored with private networking.')
param postgresFirewallRules array = []

@description('PostgreSQL extensions to allow-list (azure.extensions), for example pgcrypto, if the migrations run CREATE EXTENSION.')
param postgresAllowedExtensions array = []

@description('Extra Entra administrators for PostgreSQL in entra mode: { objectId, principalName, principalType }.')
param postgresAdditionalEntraAdmins array = []

@description('Export the high-volume PostgreSQL diagnostic categories (Query Store, sessions, table stats). Adds ingestion cost.')
param postgresVerboseDiagnostics bool = false

// ---------------------------------------------------------------------------------------------------------------
// Storage, Key Vault, registry, monitoring
// ---------------------------------------------------------------------------------------------------------------

@description('Storage replication SKU.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_GZRS'
])
param storageSku string = 'Standard_LRS'

@description('Move case blobs to the Cool tier after this many days without modification (0 disables).')
@minValue(0)
param blobCoolAfterDays int = 30

@description('Delete case blobs after this many days without modification (0 disables). Align with the application data-retention policy.')
@minValue(0)
param blobDeleteAfterDays int = 0

@description('Blob and container soft delete retention in days.')
@minValue(1)
@maxValue(365)
param blobSoftDeleteDays int = 7

@description('Key Vault soft delete retention in days (7-90, fixed at creation).')
@minValue(7)
@maxValue(90)
param keyVaultSoftDeleteDays int = 90

@description('Key Vault purge protection (irreversible once enabled). When on, a deleted vault name stays reserved for the soft delete period; use nameSalt to deploy again sooner.')
param keyVaultPurgeProtection bool = true

@description('Container registry SKU. Basic is enough for dev.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param registrySku string = 'Basic'

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

@description('Daily Log Analytics ingestion cap in GB (-1 disables). When reached, ingestion stops until the next UTC day.')
@minValue(-1)
param logDailyCapGb int = -1

@description('Send logs and metrics of every resource to Log Analytics. Turning this off removes observability; use only for throwaway environments.')
param diagnosticsEnabled bool = true

@description('Export Container Apps ingress (HTTP access) logs. They include request paths and client IPs (personal data) and add ingestion cost.')
param containerAppsHttpLogs bool = false

// ---------------------------------------------------------------------------------------------------------------
// Optional services
// ---------------------------------------------------------------------------------------------------------------

@description('Deploy Azure AI Search. When false the application uses the lexical search provider.')
param deploySearch bool = false

@description('AI Search tier. free has hard limits and no private endpoints; see modules/search.bicep.')
@allowed([
  'free'
  'basic'
  'standard'
  'standard2'
  'standard3'
  'storage_optimized_l1'
  'storage_optimized_l2'
])
param searchSku string = 'basic'

@description('AI Search replica count (ignored on free).')
@minValue(1)
@maxValue(12)
param searchReplicaCount int = 1

@description('AI Search partition count (ignored on free).')
@allowed([
  1
  2
  3
  4
  6
  12
])
param searchPartitionCount int = 1

@description('Name of the AI Search index the application uses (AZURE_SEARCH_INDEX). This template does not create it.')
param searchIndexName string = 'caseguard'

@description('Create a new Azure OpenAI account. Off by default. Mutually exclusive with existingOpenAiResourceId. See modules/openai.bicep for region, quota and model-access constraints.')
param deployOpenAi bool = false

@description('Full resource id of an EXISTING Azure OpenAI account to use instead of creating one. The identity receives the Cognitive Services OpenAI User role on it.')
param existingOpenAiResourceId string = ''

@description('Endpoint of the existing account, for example https://<custom-subdomain>.openai.azure.com/. Required with existingOpenAiResourceId.')
param existingOpenAiEndpoint string = ''

@description('Azure OpenAI deployment name the application calls (AZURE_OPENAI_DEPLOYMENT). Must exist on the account.')
param openAiDeploymentName string = 'caseguard-chat'

@description('Azure OpenAI REST API version used by the application (AZURE_OPENAI_API_VERSION).')
param openAiApiVersion string = '2024-10-21'

@description('Also create the model deployment on a NEW account. Off by default because it needs model access, regional availability and quota. See the warning in modules/openai.bicep.')
param deployOpenAiModel bool = false

@description('Model name for the new deployment. Required with deployOpenAiModel.')
param openAiModelName string = ''

@description('Model version for the new deployment. Required with deployOpenAiModel.')
param openAiModelVersion string = ''

@description('Deployment SKU of the new model deployment.')
@allowed([
  'Standard'
  'GlobalStandard'
  'DataZoneStandard'
  'ProvisionedManaged'
])
param openAiModelSkuName string = 'Standard'

@description('Capacity of the new model deployment (thousands of tokens per minute for pay-as-you-go SKUs).')
@minValue(1)
param openAiModelCapacity int = 10

@description('Deploy a Redis cache. Off by default; the application uses an in-memory cache and has no Redis support yet.')
param deployRedis bool = false

@description('Redis offering: managed (Azure Managed Redis) or cache (classic Azure Cache for Redis, closed to new customers).')
@allowed([
  'managed'
  'cache'
])
param redisOffering string = 'managed'

@description('Azure Managed Redis SKU, for example Balanced_B0.')
param redisManagedSku string = 'Balanced_B0'

// ---------------------------------------------------------------------------------------------------------------
// Private networking
// ---------------------------------------------------------------------------------------------------------------

@description('Create a VNet, integrate the Container Apps environment and put Key Vault, Storage, PostgreSQL, AI Search (and optional OpenAI/Redis) behind private endpoints with public access disabled.')
param enablePrivateNetworking bool = false

@description('Address space of the VNet (private networking only).')
param vnetAddressPrefix string = '10.40.0.0/16'

@description('Container Apps subnet prefix (private networking only).')
param containerAppsSubnetPrefix string = '10.40.0.0/23'

@description('Private endpoint subnet prefix (private networking only).')
param privateEndpointSubnetPrefix string = '10.40.2.0/26'

// ---------------------------------------------------------------------------------------------------------------
// Budget and alerts
// ---------------------------------------------------------------------------------------------------------------

@description('Monthly budget for the resource group in the billing currency. A notification threshold, not an estimate.')
@minValue(1)
param monthlyBudgetAmount int

@description('First day of the budget period (yyyy-MM-01). Defaults to the first day of the current month; pass the original value on later deployments to avoid budget drift.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Percentages of actual spend that notify (at most four).')
@maxLength(4)
param budgetActualThresholds array = [
  50
  80
  100
]

@description('Percentage of forecasted spend that notifies (0 disables).')
@minValue(0)
param budgetForecastThreshold int = 100

@description('E-mail addresses for budget notifications and alerts. Use a shared mailbox or distribution list.')
@minLength(1)
param contactEmails array

@description('Deploy the action group and the API metric alerts (requires deployContainerApps).')
param deployAlerts bool = true

@description('5xx responses in 15 minutes that trigger the server-error alert.')
@minValue(1)
param alertServerErrorThreshold int = 5

@description('Average API response time in milliseconds over 15 minutes that triggers the latency alert.')
@minValue(1)
param alertResponseTimeThresholdMs int = 2000

// ---------------------------------------------------------------------------------------------------------------
// Names and tags
// ---------------------------------------------------------------------------------------------------------------

var envShort = {
  dev: 'dev'
  staging: 'stg'
  prod: 'prd'
}[environmentName]

var suffix = take(uniqueString(subscription().subscriptionId, workloadName, environmentName, nameSalt), 6)
var baseName = '${workloadName}-${envShort}-${suffix}'
var compactName = '${workloadName}${envShort}${suffix}'

var names = {
  resourceGroup: 'rg-${workloadName}-${envShort}'
  workspace: 'log-${baseName}'
  appInsights: 'appi-${baseName}'
  identity: 'id-${baseName}'
  vnet: 'vnet-${baseName}'
  keyVault: 'kv-${baseName}'
  registry: 'cr${compactName}'
  storage: 'st${compactName}'
  postgres: 'psql-${baseName}'
  search: 'srch-${baseName}'
  openAi: 'oai-${baseName}'
  redis: 'redis-${baseName}'
  containerAppsEnvironment: 'cae-${baseName}'
  webApp: 'ca-${workloadName}-web-${envShort}-${suffix}'
  apiApp: 'ca-${workloadName}-api-${envShort}-${suffix}'
  migrateJob: 'caj-${workloadName}-migrate-${envShort}-${suffix}'
  budget: 'budget-${workloadName}-${envShort}'
  actionGroup: 'ag-${baseName}'
  alertPrefix: 'alert-${workloadName}-${envShort}'
}

var tags = {
  application: 'caseguard'
  environment: environmentName
  owner: owner
  costCenter: costCenter
  // Everything in this repository is synthetic demo data. Re-run the threat model before changing this.
  dataClassification: 'synthetic-demo'
  managedBy: 'bicep'
}

var appEnvironment = environmentName == 'prod'
  ? 'production'
  : (environmentName == 'staging' ? 'staging' : 'development')

// Name of the private blob container created by the storage module and referenced by the role assignment.
var caseContainerName = 'cases'

// ---------------------------------------------------------------------------------------------------------------
// Derived settings and guards (fail() runs only when its expression is evaluated, so each guard feeds a value
// that is used below)
// ---------------------------------------------------------------------------------------------------------------

var existingOpenAiParts = split(existingOpenAiResourceId, '/')
// Nested ternaries keep the index accesses lazy: they run only for a nine-segment resource id.
var existingOpenAiIsWellFormed = length(existingOpenAiParts) == 9
  ? (toLower(existingOpenAiParts[6]) == 'microsoft.cognitiveservices' && toLower(existingOpenAiParts[7]) == 'accounts')
  : false

var openAiMode = !empty(existingOpenAiResourceId)
  ? (deployOpenAi
      ? fail('Set either deployOpenAi or existingOpenAiResourceId, not both.')
      : (existingOpenAiIsWellFormed
          ? (empty(existingOpenAiEndpoint)
              ? fail('existingOpenAiEndpoint is required when existingOpenAiResourceId is set.')
              : 'existing')
          : fail('existingOpenAiResourceId must be a full resource id of a Microsoft.CognitiveServices/accounts resource.')))
  : (deployOpenAi ? 'new' : 'none')

var existingOpenAiSubscriptionId = openAiMode == 'existing' ? existingOpenAiParts[2] : subscription().subscriptionId
var existingOpenAiResourceGroup = openAiMode == 'existing' ? existingOpenAiParts[4] : names.resourceGroup
var existingOpenAiName = openAiMode == 'existing' ? existingOpenAiParts[8] : 'not-used'

var checkedImageTag = deployContainerApps
  ? (empty(imageTag)
      ? fail('imageTag is required when deployContainerApps is true. Build and push the images first.')
      : (environmentName == 'prod' && toLower(imageTag) == 'latest'
          ? fail('The latest tag is mutable and is rejected in prod. Deploy an immutable tag (commit SHA or version).')
          : imageTag))
  : imageTag

var alertsEnabled = deployAlerts && deployContainerApps

var redisZoneName = redisOffering == 'managed' ? 'privatelink.redis.azure.net' : 'privatelink.redis.cache.windows.net'

var privateDnsZones = concat(
  [
    {
      key: 'keyVault'
      name: 'privatelink.vaultcore.azure.net'
    }
    {
      key: 'blob'
      name: 'privatelink.blob.${environment().suffixes.storage}'
    }
    {
      key: 'postgres'
      name: 'privatelink.postgres.database.azure.com'
    }
  ],
  deploySearch
    ? [
        {
          key: 'search'
          name: 'privatelink.search.windows.net'
        }
      ]
    : [],
  openAiMode == 'new'
    ? [
        {
          key: 'openAi'
          name: 'privatelink.openai.azure.com'
        }
        {
          key: 'cognitiveServices'
          name: 'privatelink.cognitiveservices.azure.com'
        }
      ]
    : [],
  deployRedis
    ? [
        {
          key: 'redis'
          name: redisZoneName
        }
      ]
    : []
)

// ---------------------------------------------------------------------------------------------------------------
// Resource group
// ---------------------------------------------------------------------------------------------------------------

resource resourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: names.resourceGroup
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------------------------------------------
// Foundation
// ---------------------------------------------------------------------------------------------------------------

module monitoring 'modules/monitoring.bicep' = {
  scope: resourceGroup
  name: 'monitoring'
  params: {
    location: location
    workspaceName: names.workspace
    appInsightsName: names.appInsights
    tags: tags
    retentionInDays: logRetentionDays
    dailyCapGb: logDailyCapGb
  }
}

module identity 'modules/identity.bicep' = {
  scope: resourceGroup
  name: 'identity'
  params: {
    location: location
    name: names.identity
    tags: tags
  }
}

module network 'modules/network.bicep' = if (enablePrivateNetworking) {
  scope: resourceGroup
  name: 'network'
  params: {
    location: location
    vnetName: names.vnet
    tags: tags
    addressPrefix: vnetAddressPrefix
    containerAppsSubnetPrefix: containerAppsSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    privateDnsZones: privateDnsZones
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
  }
}

var privateEndpointSubnetId = network.?outputs.privateEndpointSubnetId ?? ''
var containerAppsSubnetId = network.?outputs.containerAppsSubnetId ?? ''
var keyVaultZoneId = network.?outputs.privateDnsZoneIds.?keyVault ?? ''
var blobZoneId = network.?outputs.privateDnsZoneIds.?blob ?? ''
var postgresZoneId = network.?outputs.privateDnsZoneIds.?postgres ?? ''
var searchZoneId = network.?outputs.privateDnsZoneIds.?search ?? ''
var openAiZoneId = network.?outputs.privateDnsZoneIds.?openAi ?? ''
var cognitiveServicesZoneId = network.?outputs.privateDnsZoneIds.?cognitiveServices ?? ''
var redisZoneId = network.?outputs.privateDnsZoneIds.?redis ?? ''

// ---------------------------------------------------------------------------------------------------------------
// Data and platform services
// ---------------------------------------------------------------------------------------------------------------

module registry 'modules/acr.bicep' = {
  scope: resourceGroup
  name: 'registry'
  params: {
    location: location
    name: names.registry
    tags: tags
    sku: registrySku
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
  }
}

module storage 'modules/storage.bicep' = {
  scope: resourceGroup
  name: 'storage'
  params: {
    location: location
    name: names.storage
    tags: tags
    skuName: storageSku
    containerName: caseContainerName
    coolAfterDays: blobCoolAfterDays
    deleteAfterDays: blobDeleteAfterDays
    softDeleteDays: blobSoftDeleteDays
    usePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    privateDnsZoneId: blobZoneId
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
  }
}

module postgres 'modules/postgres.bicep' = {
  scope: resourceGroup
  name: 'postgres'
  params: {
    location: location
    name: names.postgres
    tags: tags
    authMode: postgresAuthMode
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdminPassword
    managedIdentityName: identity.outputs.name
    // The principal id exists only after the identity is created, and the Entra administrator resource must be
    // named after it, so What-If cannot predict that resource before the first deployment.
    #disable-next-line what-if-short-circuiting
    managedIdentityPrincipalId: identity.outputs.principalId
    additionalEntraAdmins: postgresAdditionalEntraAdmins
    skuTier: postgresSkuTier
    skuName: postgresSkuName
    version: postgresVersion
    storageSizeGb: postgresStorageGb
    backupRetentionDays: postgresBackupRetentionDays
    geoRedundantBackup: postgresGeoRedundantBackup
    highAvailability: postgresHighAvailability
    allowAzureServices: postgresAllowAzureServices
    firewallRules: postgresFirewallRules
    allowedExtensions: postgresAllowedExtensions
    usePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    privateDnsZoneId: postgresZoneId
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
    verboseDiagnostics: postgresVerboseDiagnostics
  }
}

module search 'modules/search.bicep' = if (deploySearch) {
  scope: resourceGroup
  name: 'search'
  params: {
    location: location
    name: names.search
    tags: tags
    skuName: searchSku
    replicaCount: searchReplicaCount
    partitionCount: searchPartitionCount
    usePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    privateDnsZoneId: searchZoneId
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
  }
}

module openAi 'modules/openai.bicep' = if (openAiMode == 'new') {
  scope: resourceGroup
  name: 'openai'
  params: {
    location: location
    name: names.openAi
    tags: tags
    deployModel: deployOpenAiModel
    deploymentName: openAiDeploymentName
    modelName: openAiModelName
    modelVersion: openAiModelVersion
    modelSkuName: openAiModelSkuName
    modelCapacity: openAiModelCapacity
    usePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    privateDnsZoneIds: [
      openAiZoneId
      cognitiveServicesZoneId
    ]
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
  }
}

module redis 'modules/redis.bicep' = if (deployRedis) {
  scope: resourceGroup
  name: 'redis'
  params: {
    location: location
    name: names.redis
    tags: tags
    offering: redisOffering
    managedSkuName: redisManagedSku
    principalId: identity.outputs.principalId
    principalName: identity.outputs.name
    usePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    privateDnsZoneId: redisZoneId
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
  }
}

// Connection URLs. The password form is stored only in Key Vault; the Entra form carries no secret.
var databasePasswordUrl = 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.outputs.fqdn}:5432/${postgres.outputs.databaseName}?sslmode=require'
var databaseEntraUrl = 'postgres://${uriComponent(identity.outputs.name)}@${postgres.outputs.fqdn}:5432/${postgres.outputs.databaseName}?sslmode=require'

module keyVault 'modules/keyvault.bicep' = {
  scope: resourceGroup
  name: 'keyvault'
  params: {
    location: location
    name: names.keyVault
    tags: tags
    softDeleteRetentionDays: keyVaultSoftDeleteDays
    enablePurgeProtection: keyVaultPurgeProtection
    usePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    privateDnsZoneId: keyVaultZoneId
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
    appInsightsName: names.appInsights
    storeDatabaseCredentials: postgresAuthMode == 'password'
    databaseUrl: postgresAuthMode == 'password' ? databasePasswordUrl : ''
    postgresAdminPassword: postgresAuthMode == 'password' ? postgresAdminPassword : ''
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Role assignments
// ---------------------------------------------------------------------------------------------------------------

// Resource names are passed as known-at-start values and ordering is explicit, so What-If can predict the
// assignments; the only runtime input is the principal id.
module rbac 'modules/rbac.bicep' = {
  scope: resourceGroup
  name: 'rbac'
  params: {
    // Role assignment names include the principal id (so a recreated identity never collides with an orphaned
    // assignment), which exists only after the identity is created.
    #disable-next-line what-if-short-circuiting
    principalId: identity.outputs.principalId
    registryName: names.registry
    keyVaultName: names.keyVault
    storageAccountName: names.storage
    storageContainerName: caseContainerName
    searchServiceName: deploySearch ? names.search : ''
    openAiAccountName: openAiMode == 'new' ? names.openAi : ''
  }
  dependsOn: [
    registry
    keyVault
    storage
    search
    openAi
  ]
}

module rbacOpenAiExisting 'modules/rbac-openai-existing.bicep' = if (openAiMode == 'existing') {
  // The az. prefix is needed because the resource symbol named resourceGroup shadows the function of the same name.
  scope: az.resourceGroup(existingOpenAiSubscriptionId, existingOpenAiResourceGroup)
  name: 'rbac-openai-existing'
  params: {
    // See the note on the rbac module: the principal id is a runtime value.
    #disable-next-line what-if-short-circuiting
    principalId: identity.outputs.principalId
    accountName: existingOpenAiName
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Container Apps
// ---------------------------------------------------------------------------------------------------------------

var openAiEndpoint = openAiMode == 'existing' ? existingOpenAiEndpoint : (openAi.?outputs.endpoint ?? '')

module containerApps 'modules/containerapps.bicep' = {
  scope: resourceGroup
  name: 'containerapps'
  params: {
    location: location
    tags: tags
    environmentName: names.containerAppsEnvironment
    webAppName: names.webApp
    apiAppName: names.apiApp
    migrateJobName: names.migrateJob
    infrastructureSubnetId: containerAppsSubnetId
    zoneRedundant: containerAppsZoneRedundant
    workspaceId: monitoring.outputs.workspaceId
    diagnosticsEnabled: diagnosticsEnabled
    httpLogsEnabled: containerAppsHttpLogs
    deployApps: deployContainerApps
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    registryLoginServer: registry.outputs.loginServer
    imageTag: checkedImageTag
    webImageRepository: webImageRepository
    apiImageRepository: apiImageRepository
    web: {
      cpu: webCpu
      memory: webMemory
      minReplicas: webMinReplicas
      maxReplicas: webMaxReplicas
      concurrentRequests: webConcurrentRequests
    }
    api: {
      cpu: apiCpu
      memory: apiMemory
      minReplicas: apiMinReplicas
      maxReplicas: apiMaxReplicas
      concurrentRequests: apiConcurrentRequests
    }
    webAllowedIpRanges: webAllowedIpRanges
    migrationTimeoutSeconds: migrationTimeoutSeconds
    databaseUrlSecretUri: keyVault.outputs.databaseUrlSecretUri
    appInsightsSecretUri: keyVault.outputs.appInsightsSecretUri
    config: {
      appEnv: appEnvironment
      appVersion: empty(appVersion) ? imageTag : appVersion
      gitCommit: gitCommit
      logLevel: logLevel
      entraTenantId: entraTenantId
      entraAudience: entraApiAudience
      entraTenantMap: string(entraTenantMap)
      entraRoleMap: string(entraRoleMap)
      webEntraClientId: entraWebClientId
      webEntraApiScope: entraApiScope
      databaseAuth: postgresAuthMode
      databaseUrl: postgresAuthMode == 'entra' ? databaseEntraUrl : ''
      dbPoolMax: databasePoolMax
      storageAccountName: storage.outputs.name
      storageContainerName: storage.outputs.containerName
      searchEndpoint: search.?outputs.endpoint ?? ''
      searchIndex: searchIndexName
      openAiEndpoint: openAiEndpoint
      openAiDeployment: empty(openAiEndpoint) ? '' : openAiDeploymentName
      openAiApiVersion: empty(openAiEndpoint) ? '' : openAiApiVersion
      aiMaxInputTokens: aiMaxInputTokens
      aiMaxOutputTokens: aiMaxOutputTokens
      aiTimeoutMs: aiTimeoutMs
      aiMaxRetries: aiMaxRetries
      aiCostLimitUsdPerDay: aiCostLimitUsdPerDay
      aiUnitPriceInputPer1k: aiUnitPriceInputPer1k
      aiUnitPriceOutputPer1k: aiUnitPriceOutputPer1k
      otelSamplingRatio: otelSamplingRatio
      demoMode: demoMode
      demoAutoSeed: demoAutoSeed
    }
  }
  // The registry pull and Key Vault secret references are validated when the apps are created, so the role
  // assignments must already exist. They are not referenced by any property here, hence the explicit dependency.
  dependsOn: [
    rbac
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Cost and alerts
// ---------------------------------------------------------------------------------------------------------------

module budget 'modules/budget.bicep' = {
  scope: resourceGroup
  name: 'budget'
  params: {
    name: names.budget
    amount: monthlyBudgetAmount
    startDate: budgetStartDate
    contactEmails: contactEmails
    actualThresholds: budgetActualThresholds
    forecastThreshold: budgetForecastThreshold
  }
}

module alerts 'modules/alerts.bicep' = if (alertsEnabled) {
  scope: resourceGroup
  name: 'alerts'
  params: {
    tags: tags
    actionGroupName: names.actionGroup
    actionGroupShortName: 'cg-${envShort}-alert'
    emailAddresses: contactEmails
    apiAppId: containerApps.outputs.apiAppId
    alertNamePrefix: names.alertPrefix
    serverErrorThreshold: alertServerErrorThreshold
    responseTimeThresholdMs: alertResponseTimeThresholdMs
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Outputs: names, ids and host names only. Never secrets.
// ---------------------------------------------------------------------------------------------------------------

@description('Resource group that holds the environment.')
output resourceGroupName string = resourceGroup.name

@description('Container registry name (use with az acr build).')
output containerRegistryName string = registry.outputs.name

@description('Container registry login server.')
output containerRegistryLoginServer string = registry.outputs.loginServer

@description('Key Vault name.')
output keyVaultName string = keyVault.outputs.name

@description('Key Vault URI.')
output keyVaultUri string = keyVault.outputs.vaultUri

@description('Storage account name.')
output storageAccountName string = storage.outputs.name

@description('PostgreSQL server name.')
output postgresServerName string = postgres.outputs.name

@description('PostgreSQL fully qualified domain name.')
output postgresFqdn string = postgres.outputs.fqdn

@description('Log Analytics workspace name.')
output logAnalyticsWorkspaceName string = monitoring.outputs.workspaceName

@description('Application Insights component name.')
output appInsightsName string = monitoring.outputs.appInsightsName

@description('User-assigned managed identity name (also the PostgreSQL role name in entra mode).')
output managedIdentityName string = identity.outputs.name

@description('Container Apps environment name.')
output containerAppsEnvironmentName string = containerApps.outputs.environmentName

@description('Web app name.')
output webAppName string = containerApps.outputs.webAppName

@description('API app name.')
output apiAppName string = containerApps.outputs.apiAppName

@description('Migration job name.')
output migrateJobName string = containerApps.outputs.migrateJobName

@description('Public URL of the web app (empty until the apps are deployed).')
output webUrl string = empty(containerApps.outputs.webFqdn) ? '' : 'https://${containerApps.outputs.webFqdn}'

@description('Internal FQDN of the API (not reachable from the internet; empty until the apps are deployed).')
output apiInternalFqdn string = containerApps.outputs.apiFqdn

@description('AI Search endpoint (empty when AI Search is not deployed).')
output searchEndpoint string = search.?outputs.endpoint ?? ''

@description('Azure OpenAI endpoint the application uses (empty for the deterministic provider).')
output openAiEndpoint string = openAiEndpoint

@description('KEY=VALUE build arguments for the WEB image. Next.js inlines the NEXT_PUBLIC_* values into the client build, so the web image is specific to this environment (its Entra registration). None of these values is a secret. The API address is not one of them: the web container reads API_INTERNAL_URL at runtime (see the web app in containerapps.bicep).')
output webBuildArguments array = [
  'NEXT_PUBLIC_AUTH_MODE=entra'
  'NEXT_PUBLIC_APP_ENV=${appEnvironment}'
  'NEXT_PUBLIC_ENTRA_CLIENT_ID=${entraWebClientId}'
  'NEXT_PUBLIC_ENTRA_AUTHORITY=${environment().authentication.loginEndpoint}${entraTenantId}'
  'NEXT_PUBLIC_ENTRA_API_SCOPE=${entraApiScope}'
]
