// PostgreSQL Flexible Server + the `caseguard` database.
//
// Authentication modes (authMode):
//   password - administrator login/password (dev). Entra authentication is off.
//   entra    - password authentication disabled; the shared managed identity (and any extra principals) are
//              Microsoft Entra administrators. Recommended for staging/prod.
// Networking: public access with an empty firewall by default. Private endpoint (publicNetworkAccess Disabled)
// when usePrivateEndpoint is true. VNet-integrated (delegated subnet) servers are not used because
// they cannot be combined with private endpoints.
//
// Everything that mutates the server (database, parameters, administrators, firewall rules) is chained with
// dependsOn: the Flexible Server API serialises those operations and rejects overlapping ones with ServerIsBusy.

@description('Azure region. SKU and zone availability for PostgreSQL Flexible Server varies per region and subscription.')
param location string

@description('Server name: 3-63 characters, lowercase letters, digits and hyphens, globally unique per region DNS name.')
@minLength(3)
@maxLength(63)
param name string

@description('Tags applied to every resource in this module.')
param tags object

@description('Application database name.')
param databaseName string = 'caseguard'

@description('Authentication mode: password (dev) or entra (Entra-only).')
@allowed([
  'password'
  'entra'
])
param authMode string

@description('Administrator login for password mode. Must not be a reserved name such as admin, postgres or azure_superuser.')
@minLength(1)
@maxLength(63)
param administratorLogin string = 'cgadmin'

@description('Administrator password for password mode (at least 16 characters). Ignored in entra mode.')
@secure()
param administratorPassword string = ''

@description('Entra tenant id used for Entra authentication.')
param entraTenantId string = tenant().tenantId

@description('Name of the managed identity; it becomes the PostgreSQL role name in entra mode.')
param managedIdentityName string

@description('Object (principal) id of the managed identity; registered as Entra administrator in entra mode.')
param managedIdentityPrincipalId string

@description('Extra Entra administrators (entra mode), for example an operators security group. Items: { objectId, principalName, principalType } where principalType is User, Group or ServicePrincipal.')
param additionalEntraAdmins array = []

@description('Compute tier. Burstable is the cheapest and does not support high availability.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param skuTier string = 'Burstable'

@description('Compute SKU name matching skuTier, for example Standard_B1ms, Standard_D2ds_v5, Standard_E2ds_v5. Verify availability in your region and subscription.')
param skuName string = 'Standard_B1ms'

@description('PostgreSQL major version.')
@allowed([
  '15'
  '16'
  '17'
])
param version string = '16'

@description('Storage size in GB (32 or more).')
@minValue(32)
param storageSizeGb int = 32

@description('Grow storage automatically instead of going read-only when the disk is full. Growth is not reversible and increases cost.')
param storageAutoGrow bool = true

@description('Backup retention in days (7-35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@description('Geo-redundant backups (not available in every region; roughly doubles backup storage).')
param geoRedundantBackup bool = false

@description('High availability mode. Requires GeneralPurpose or MemoryOptimized tier.')
@allowed([
  'Disabled'
  'SameZone'
  'ZoneRedundant'
])
param highAvailability string = 'Disabled'

@description('DEV ONLY: add the 0.0.0.0 rule that lets any Azure-hosted client attempt a connection (authentication and TLS are still required). Needed when the Container Apps environment has no VNet. Ignored with a private endpoint.')
param allowAzureServices bool = false

@description('Explicit public firewall rules: { name, startIpAddress, endIpAddress }. Ignored with a private endpoint.')
param firewallRules array = []

@description('Extensions to allow-list (azure.extensions), for example pgcrypto. Required before CREATE EXTENSION works in migrations.')
param allowedExtensions array = []

@description('Create a private endpoint and disable public network access. Requires privateEndpointSubnetId and privateDnsZoneId. Without it the server is public with a closed firewall.')
param usePrivateEndpoint bool = false

@description('Subnet for the private endpoint (used when usePrivateEndpoint is true).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id for privatelink.postgres.database.azure.com (used when usePrivateEndpoint is true).')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

@description('Also export the high-volume Query Store, session, transaction and table statistics categories. Off by default because each adds ingestion cost.')
param verboseDiagnostics bool = false

var usePassword = authMode == 'password'

// fail() only runs when the expression is evaluated, so these values are referenced by resource properties below.
var passwordPolicyOk = usePassword
  ? (length(administratorPassword) >= 16
      ? true
      : fail('administratorPassword must be at least 16 characters when authMode is password.'))
  : true
var haPolicyOk = highAvailability != 'Disabled' && skuTier == 'Burstable'
  ? fail('High availability is not supported on the Burstable tier. Use GeneralPurpose or MemoryOptimized.')
  : true

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: version
    createMode: 'Default'
    administratorLogin: usePassword ? administratorLogin : null
    administratorLoginPassword: usePassword && passwordPolicyOk ? administratorPassword : null
    authConfig: {
      activeDirectoryAuth: usePassword ? 'Disabled' : 'Enabled'
      passwordAuth: usePassword ? 'Enabled' : 'Disabled'
      tenantId: entraTenantId
    }
    storage: {
      storageSizeGB: storageSizeGb
      autoGrow: storageAutoGrow ? 'Enabled' : 'Disabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: haPolicyOk ? highAvailability : 'Disabled'
    }
    network: {
      publicNetworkAccess: usePrivateEndpoint ? 'Disabled' : 'Enabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource requireSecureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
  dependsOn: [
    database
  ]
}

resource minTlsVersion 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'ssl_min_protocol_version'
  properties: {
    value: 'TLSv1.2'
    source: 'user-override'
  }
  dependsOn: [
    requireSecureTransport
  ]
}

resource extensionAllowList 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = if (!empty(allowedExtensions)) {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: join(allowedExtensions, ',')
    source: 'user-override'
  }
  dependsOn: [
    minTlsVersion
  ]
}

resource identityAdministrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = if (!usePassword) {
  parent: server
  name: managedIdentityPrincipalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: managedIdentityName
    tenantId: entraTenantId
  }
  dependsOn: [
    minTlsVersion
    extensionAllowList
  ]
}

@batchSize(1)
resource extraAdministrators 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = [
  for admin in additionalEntraAdmins: if (!usePassword) {
    parent: server
    name: admin.objectId
    properties: {
      principalType: admin.principalType
      principalName: admin.principalName
      tenantId: entraTenantId
    }
    dependsOn: [
      identityAdministrator
    ]
  }
]

resource azureServicesRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = if (allowAzureServices && !usePrivateEndpoint) {
  parent: server
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [
    minTlsVersion
    extensionAllowList
  ]
}

@batchSize(1)
resource customFirewallRules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = [
  for rule in firewallRules: if (!usePrivateEndpoint) {
    parent: server
    name: rule.name
    properties: {
      startIpAddress: rule.startIpAddress
      endIpAddress: rule.endIpAddress
    }
    dependsOn: [
      azureServicesRule
    ]
  }
]

module privateEndpoint 'private-endpoint.bicep' = if (usePrivateEndpoint) {
  name: 'pe-postgres'
  params: {
    location: location
    name: 'pe-${name}'
    tags: tags
    subnetId: privateEndpointSubnetId
    privateLinkServiceId: server.id
    groupId: 'postgresqlServer'
    privateDnsZoneIds: [
      privateDnsZoneId
    ]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: server
  properties: {
    workspaceId: workspaceId
    logs: verboseDiagnostics
      ? [
          {
            categoryGroup: 'allLogs'
            enabled: true
          }
        ]
      : [
          {
            category: 'PostgreSQLLogs'
            enabled: true
          }
        ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('Resource id of the server.')
output id string = server.id

@description('Server name.')
output name string = server.name

@description('Fully qualified domain name of the server (resolves to the private IP when a private endpoint is used).')
output fqdn string = server.properties.fullyQualifiedDomainName

@description('Application database name.')
output databaseName string = database.name

@description('Administrator login (password mode) - an identifier, not a secret.')
output administratorLogin string = administratorLogin
