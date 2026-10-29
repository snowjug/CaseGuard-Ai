// Container Apps environment, the `web` and `api` apps and the manual `migrate` job.
//
// Topology: only `web` has external ingress. `api` has INTERNAL ingress: the browser reaches it through the web app's
// same-origin /api rewrite, whose server-side target is API_INTERNAL_URL. The `migrate` job runs the API image with
// `node dist/db/migrate-cli.js` and is started manually (az containerapp job start).
//
// Secrets are never inline: every secret is a Key Vault reference resolved with the user-assigned identity, which must
// already hold "Key Vault Secrets User" and "AcrPull" (main.bicep orders this module after rbac.bicep).
// Deploying with deployApps=false creates only the environment, which is how the first deployment works before
// any image exists in the registry.

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Container Apps environment name.')
param environmentName string

@description('Web app name (2-32 characters, lowercase letters, digits and hyphens).')
@minLength(2)
@maxLength(32)
param webAppName string

@description('API app name (2-32 characters, lowercase letters, digits and hyphens).')
@minLength(2)
@maxLength(32)
param apiAppName string

@description('Migration job name (2-32 characters, lowercase letters, digits and hyphens).')
@minLength(2)
@maxLength(32)
param migrateJobName string

@description('Subnet delegated to Microsoft.App/environments. Empty creates an environment without VNet integration.')
param infrastructureSubnetId string = ''

@description('Spread the environment across availability zones. Requires VNet integration and a zone-enabled region.')
param zoneRedundant bool = false

@description('Log Analytics workspace resource id that receives the environment logs.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

@description('Also export ingress (HTTP access) logs. They contain request paths and client IPs (personal data) and add ingestion cost.')
param httpLogsEnabled bool = false

@description('Create the apps and the job. False creates only the environment.')
param deployApps bool

@description('Resource id of the user-assigned managed identity used for registry pulls, Key Vault references and Azure SDK calls.')
param identityId string

@description('Client id of the managed identity, exposed as AZURE_CLIENT_ID.')
param identityClientId string

@description('Container registry login server, for example crexample.azurecr.io.')
param registryLoginServer string

@description('Image tag shared by the web and API images. Required when deployApps is true.')
param imageTag string = ''

@description('Repository of the web image in the registry.')
param webImageRepository string

@description('Repository of the API image in the registry (also runs the migration job).')
param apiImageRepository string

@description('Size and scale settings of the web app.')
param web appSizing

@description('Size and scale settings of the API.')
param api appSizing

@description('CIDR ranges (or single IPs) allowed to reach the web app. Empty means any client; non-empty denies everything else.')
param webAllowedIpRanges array = []

@description('Maximum run time of the migration job in seconds.')
@minValue(60)
@maxValue(3600)
param migrationTimeoutSeconds int = 900

@description('Versionless Key Vault secret URI of database-url. Required when config.databaseAuth is password.')
param databaseUrlSecretUri string = ''

@description('Versionless Key Vault secret URI of the Application Insights connection string.')
param appInsightsSecretUri string

@description('Application configuration translated into the environment-variable contract.')
param config runtimeConfig

@description('vCPU and memory of an app. Memory must follow the platform pairing for the Consumption profile (for example 0.25 vCPU with 0.5Gi, 0.5 with 1.0Gi, 1.0 with 2.0Gi).')
type appSizing = {
  @description('vCPU as a decimal string, for example 0.25.')
  cpu: string

  @description('Memory, for example 0.5Gi.')
  memory: string

  @description('Minimum replicas. 0 scales to zero (cold starts, no idle cost).')
  @minValue(0)
  minReplicas: int

  @description('Maximum replicas.')
  @minValue(1)
  maxReplicas: int

  @description('Concurrent HTTP requests per replica that trigger scale-out.')
  @minValue(1)
  concurrentRequests: int
}

@description('Application settings; each field maps to one variable of the environment contract.')
type runtimeConfig = {
  appEnv: 'development' | 'staging' | 'production'
  appVersion: string
  gitCommit: string
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  entraTenantId: string
  entraAudience: string
  entraTenantMap: string
  entraRoleMap: string
  webEntraClientId: string
  webEntraApiScope: string
  databaseAuth: 'password' | 'entra'
  @description('Non-secret connection URL used only when databaseAuth is entra.')
  databaseUrl: string
  dbPoolMax: int
  storageAccountName: string
  storageContainerName: string
  @description('Empty selects the lexical search provider.')
  searchEndpoint: string
  searchIndex: string
  @description('Empty selects the deterministic AI provider.')
  openAiEndpoint: string
  openAiDeployment: string
  openAiApiVersion: string
  aiMaxInputTokens: int
  aiMaxOutputTokens: int
  aiTimeoutMs: int
  aiMaxRetries: int
  @description('Empty means no daily limit.')
  aiCostLimitUsdPerDay: string
  @description('Operator supplied; empty means cost is reported as unknown.')
  aiUnitPriceInputPer1k: string
  @description('Operator supplied; empty means cost is reported as unknown.')
  aiUnitPriceOutputPer1k: string
  otelSamplingRatio: string
  demoMode: bool
  demoAutoSeed: bool
}

var registryConfig = [
  {
    server: registryLoginServer
    identity: identityId
  }
]

var identityConfig = {
  type: 'UserAssigned'
  userAssignedIdentities: {
    '${identityId}': {}
  }
}

var zoneRedundancyOk = zoneRedundant && empty(infrastructureSubnetId)
  ? fail('zoneRedundant requires VNet integration. Enable private networking or set zoneRedundant to false.')
  : true

var imagesOk = deployApps && empty(imageTag)
  ? fail('imageTag is required when deployApps is true. Build and push the images first, then pass their tag.')
  : true

var webImage = '${registryLoginServer}/${webImageRepository}:${imageTag}'
var apiImage = '${registryLoginServer}/${apiImageRepository}:${imageTag}'

var usesVnet = !empty(infrastructureSubnetId)

var logCategories = concat(
  [
    'ContainerAppConsoleLogs'
    'ContainerAppSystemLogs'
  ],
  httpLogsEnabled ? ['ContainerAppHTTPLogs'] : []
)

var passwordSecrets = config.databaseAuth == 'password'
  ? [
      {
        name: 'database-url'
        keyVaultUrl: databaseUrlSecretUri
        identity: identityId
      }
    ]
  : []

var appSecrets = concat(passwordSecrets, [
  {
    name: 'appinsights-connection-string'
    keyVaultUrl: appInsightsSecretUri
    identity: identityId
  }
])

var passwordEnv = config.databaseAuth == 'password'
  ? [
      {
        name: 'DATABASE_URL'
        secretRef: 'database-url'
      }
    ]
  : []

var secretEnv = concat(passwordEnv, [
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    secretRef: 'appinsights-connection-string'
  }
])

// Entries with an empty value are dropped so optional settings (search, OpenAI, limits, prices) fall back to the
// application defaults instead of being set to an empty string.
var plainEnv = filter(
  [
    { name: 'APP_ENV', value: config.appEnv }
    { name: 'APP_VERSION', value: config.appVersion }
    { name: 'GIT_COMMIT', value: config.gitCommit }
    { name: 'LOG_LEVEL', value: config.logLevel }
    // The Container Apps ingress is the one proxy in front of the API: believe the address it appended to
    // X-Forwarded-For and ignore anything a client put before it (a hop count, never `true`).
    { name: 'TRUST_PROXY', value: '1' }
    // Persona login is never enabled in Azure: the endpoints are reachable from the internet.
    { name: 'AUTH_MODE', value: 'entra' }
    { name: 'DEV_AUTH_ENABLED', value: 'false' }
    { name: 'ENTRA_TENANT_ID', value: config.entraTenantId }
    { name: 'ENTRA_AUDIENCE', value: config.entraAudience }
    { name: 'ENTRA_TENANT_MAP', value: config.entraTenantMap }
    { name: 'ENTRA_ROLE_MAP', value: config.entraRoleMap }
    { name: 'DATABASE_AUTH', value: config.databaseAuth }
    { name: 'DATABASE_URL', value: config.databaseAuth == 'entra' ? config.databaseUrl : '' }
    // Migrations are a separate, explicitly started job; replicas never migrate on startup.
    { name: 'DB_AUTO_MIGRATE', value: 'false' }
    { name: 'DB_POOL_MAX', value: string(config.dbPoolMax) }
    { name: 'STORAGE_PROVIDER', value: 'azure-blob' }
    { name: 'AZURE_STORAGE_ACCOUNT', value: config.storageAccountName }
    { name: 'AZURE_STORAGE_CONTAINER', value: config.storageContainerName }
    { name: 'SEARCH_PROVIDER', value: empty(config.searchEndpoint) ? 'lexical' : 'azure-ai-search' }
    { name: 'AZURE_SEARCH_ENDPOINT', value: config.searchEndpoint }
    { name: 'AZURE_SEARCH_INDEX', value: config.searchIndex }
    // Redis is reserved but not implemented in the application.
    { name: 'CACHE_PROVIDER', value: 'memory' }
    { name: 'AI_PROVIDER', value: empty(config.openAiEndpoint) ? 'deterministic' : 'azure-openai' }
    { name: 'AZURE_OPENAI_ENDPOINT', value: config.openAiEndpoint }
    { name: 'AZURE_OPENAI_DEPLOYMENT', value: config.openAiDeployment }
    { name: 'AZURE_OPENAI_API_VERSION', value: config.openAiApiVersion }
    { name: 'AZURE_OPENAI_AUTH', value: empty(config.openAiEndpoint) ? '' : 'managed-identity' }
    { name: 'AI_MAX_INPUT_TOKENS', value: string(config.aiMaxInputTokens) }
    { name: 'AI_MAX_OUTPUT_TOKENS', value: string(config.aiMaxOutputTokens) }
    { name: 'AI_TIMEOUT_MS', value: string(config.aiTimeoutMs) }
    { name: 'AI_MAX_RETRIES', value: string(config.aiMaxRetries) }
    { name: 'AI_COST_LIMIT_USD_PER_DAY', value: config.aiCostLimitUsdPerDay }
    { name: 'AI_UNIT_PRICE_INPUT_PER_1K', value: config.aiUnitPriceInputPer1k }
    { name: 'AI_UNIT_PRICE_OUTPUT_PER_1K', value: config.aiUnitPriceOutputPer1k }
    { name: 'OTEL_SAMPLING_RATIO', value: config.otelSamplingRatio }
    { name: 'DEMO_MODE', value: config.demoMode ? 'true' : 'false' }
    { name: 'DEMO_AUTO_SEED', value: config.demoAutoSeed ? 'true' : 'false' }
    // Selects the user-assigned identity in DefaultAzureCredential.
    { name: 'AZURE_CLIENT_ID', value: identityClientId }
  ],
  item => !empty(item.value)
)

var webIpRestrictions = [
  for (range, index) in webAllowedIpRanges: {
    name: 'allow-${index}'
    ipAddressRange: range
    action: 'Allow'
  }
]

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    // Logs go through Azure Monitor diagnostic settings below, which avoids handing out the workspace shared key.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: usesVnet
      ? {
          infrastructureSubnetId: infrastructureSubnetId
          internal: false
        }
      : null
    zoneRedundant: zoneRedundancyOk && zoneRedundant
  }
}

resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: managedEnvironment
  properties: {
    workspaceId: workspaceId
    // Resource-specific tables (ContainerAppConsoleLogs, ContainerAppSystemLogs) instead of AzureDiagnostics.
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      for category in logCategories: {
        category: category
        enabled: true
      }
    ]
  }
}

resource apiApp 'Microsoft.App/containerApps@2025-01-01' = if (deployApps && imagesOk) {
  name: apiAppName
  location: location
  tags: tags
  identity: identityConfig
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      // Multiple revisions keep the previous revision available for rollback (traffic shift or reactivation).
      activeRevisionsMode: 'Multiple'
      maxInactiveRevisions: 5
      ingress: {
        external: false
        targetPort: 4000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: registryConfig
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          command: ['node']
          // Same flags as the image's default CMD, so stack traces in the logs map to the TypeScript sources.
          args: ['--enable-source-maps', 'dist/main.js']
          resources: {
            cpu: json(api.cpu)
            memory: api.memory
          }
          env: concat(plainEnv, secretEnv, [
            { name: 'SERVICE_NAME', value: 'caseguard-api' }
            { name: 'OTEL_SERVICE_NAME', value: 'caseguard-api' }
            { name: 'API_HOST', value: '0.0.0.0' }
            { name: 'API_PORT', value: '4000' }
            {
              name: 'CORS_ALLOWED_ORIGINS'
              value: 'https://${webAppName}.${managedEnvironment.properties.defaultDomain}'
            }
          ])
          probes: [
            {
              // 6 s x 10 attempts = 60 s to boot. failureThreshold is capped at 10 in the Container Apps REST specification.
              type: 'Startup'
              httpGet: {
                path: '/livez'
                port: 4000
              }
              periodSeconds: 6
              failureThreshold: 10
              timeoutSeconds: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/livez'
                port: 4000
              }
              periodSeconds: 15
              failureThreshold: 3
              timeoutSeconds: 3
            }
            {
              // /readyz checks the database and applied migrations, so a failing readiness probe usually means
              // the migrate job has not run yet (see docs/runbooks/broken-migration.md).
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 4000
              }
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: api.minReplicas
        maxReplicas: api.maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(api.concurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

resource webApp 'Microsoft.App/containerApps@2025-01-01' = if (deployApps && imagesOk) {
  name: webAppName
  location: location
  tags: tags
  identity: identityConfig
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Multiple'
      maxInactiveRevisions: 5
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        ipSecurityRestrictions: empty(webAllowedIpRanges) ? null : webIpRestrictions
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: registryConfig
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          resources: {
            cpu: json(web.cpu)
            memory: web.memory
          }
          env: filter(
            [
              { name: 'NODE_ENV', value: 'production' }
              { name: 'PORT', value: '3000' }
              { name: 'HOSTNAME', value: '0.0.0.0' }
              { name: 'NEXT_TELEMETRY_DISABLED', value: '1' }
              // Server-side target of the same-origin /api rewrite; the API has no public endpoint.
              { name: 'API_INTERNAL_URL', value: 'https://${apiApp!.properties.configuration.ingress.fqdn}' }
              { name: 'NEXT_PUBLIC_AUTH_MODE', value: 'entra' }
              { name: 'NEXT_PUBLIC_APP_ENV', value: config.appEnv }
              { name: 'NEXT_PUBLIC_ENTRA_CLIENT_ID', value: config.webEntraClientId }
              {
                name: 'NEXT_PUBLIC_ENTRA_AUTHORITY'
                value: '${environment().authentication.loginEndpoint}${config.entraTenantId}'
              }
              { name: 'NEXT_PUBLIC_ENTRA_API_SCOPE', value: config.webEntraApiScope }
            ],
            item => !empty(item.value)
          )
          // The web app has no dedicated health route, so liveness and readiness are TCP checks on the listener.
          probes: [
            {
              type: 'Startup'
              tcpSocket: {
                port: 3000
              }
              periodSeconds: 6
              failureThreshold: 10
              timeoutSeconds: 3
            }
            {
              type: 'Liveness'
              tcpSocket: {
                port: 3000
              }
              periodSeconds: 15
              failureThreshold: 3
              timeoutSeconds: 3
            }
            {
              type: 'Readiness'
              tcpSocket: {
                port: 3000
              }
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: web.minReplicas
        maxReplicas: web.maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(web.concurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

resource migrateJob 'Microsoft.App/jobs@2025-01-01' = if (deployApps && imagesOk) {
  name: migrateJobName
  location: location
  tags: tags
  identity: identityConfig
  properties: {
    environmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: migrationTimeoutSeconds
      // A failed migration is investigated by a human, never retried blindly.
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registryConfig
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: apiImage
          command: ['node']
          args: ['--enable-source-maps', 'dist/db/migrate-cli.js']
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          // Same configuration as the API so the shared config validation passes; only the database settings matter.
          env: concat(plainEnv, secretEnv, [
            { name: 'SERVICE_NAME', value: 'caseguard-migrate' }
            { name: 'OTEL_SERVICE_NAME', value: 'caseguard-migrate' }
          ])
        }
      ]
    }
  }
}

resource webMetrics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled && deployApps && imagesOk) {
  name: 'send-to-log-analytics'
  scope: webApp
  properties: {
    workspaceId: workspaceId
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource apiMetrics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled && deployApps && imagesOk) {
  name: 'send-to-log-analytics'
  scope: apiApp
  properties: {
    workspaceId: workspaceId
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('Resource id of the Container Apps environment.')
output environmentId string = managedEnvironment.id

@description('Name of the Container Apps environment.')
output environmentName string = managedEnvironment.name

@description('Default domain of the environment.')
output defaultDomain string = managedEnvironment.properties.defaultDomain

@description('Public FQDN of the web app (empty when the apps are not deployed).')
output webFqdn string = deployApps ? webApp!.properties.configuration.ingress.fqdn : ''

@description('Internal FQDN of the API (empty when the apps are not deployed). Not reachable from the internet.')
output apiFqdn string = deployApps ? apiApp!.properties.configuration.ingress.fqdn : ''

@description('Resource id of the API app, used as the scope of metric alerts (empty when not deployed).')
output apiAppId string = deployApps ? apiApp!.id : ''

@description('Web app name.')
output webAppName string = webAppName

@description('API app name.')
output apiAppName string = apiAppName

@description('Migration job name.')
output migrateJobName string = migrateJobName
