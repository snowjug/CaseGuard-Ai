// Redis (optional, OFF by default). The application currently uses an in-memory cache and in-memory rate limits
// (CACHE_PROVIDER=memory); Redis support is reserved and NOT wired into the API. This module exists so a
// multi-replica deployment has a ready, secured cache to adopt later.
//
// Two offerings, because the classic service is being retired:
//   managed - Azure Managed Redis (Microsoft.Cache/redisEnterprise). The default and recommended offering.
//   cache   - classic Azure Cache for Redis (Microsoft.Cache/redis). Microsoft announced it is closed to new customers
//             and retiring; it can only be created in tenants that already used it. Verify before choosing it.
// Access keys are disabled; the managed identity gets data access through an Entra access policy assignment.
// Verify SKU names, regions and the retirement status on the current Azure Managed Redis documentation.

@description('Azure region. Azure Managed Redis is not available in every region.')
param location string

@description('Cache name (1-63 characters, letters, digits and hyphens).')
@minLength(1)
@maxLength(63)
param name string

@description('Tags applied to every resource in this module.')
param tags object

@description('Offering: managed (Azure Managed Redis) or cache (classic Azure Cache for Redis, closed to new customers).')
@allowed([
  'managed'
  'cache'
])
param offering string = 'managed'

@description('Azure Managed Redis SKU, for example Balanced_B0. Check the current SKU list for your region.')
param managedSkuName string = 'Balanced_B0'

@description('Classic cache tier.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param cacheSkuName string = 'Basic'

@description('Classic cache size (C family capacity 0-6).')
@minValue(0)
@maxValue(6)
param cacheCapacity int = 0

@description('Object (principal) id of the managed identity that receives data access.')
param principalId string

@description('Name of the managed identity (alias shown on the classic cache access policy assignment).')
param principalName string

@description('Create a private endpoint and disable public network access. Requires privateEndpointSubnetId and privateDnsZoneId.')
param usePrivateEndpoint bool = false

@description('Subnet for the private endpoint (used when usePrivateEndpoint is true).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id matching the offering (used when usePrivateEndpoint is true).')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

var isManaged = offering == 'managed'

resource managedRedis 'Microsoft.Cache/redisEnterprise@2025-07-01' = if (isManaged) {
  name: name
  location: location
  tags: tags
  sku: {
    name: managedSkuName
  }
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: usePrivateEndpoint ? 'Disabled' : 'Enabled'
  }
}

resource managedDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = if (isManaged) {
  parent: managedRedis
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    port: 10000
    clusteringPolicy: 'OSSCluster'
    evictionPolicy: 'VolatileLRU'
    accessKeysAuthentication: 'Disabled'
  }
}

resource managedAccess 'Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments@2025-07-01' = if (isManaged) {
  parent: managedDatabase
  name: 'appidentity'
  properties: {
    accessPolicyName: 'default'
    user: {
      objectId: principalId
    }
  }
}

resource classicRedis 'Microsoft.Cache/redis@2024-11-01' = if (!isManaged) {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: cacheSkuName
      family: 'C'
      capacity: cacheCapacity
    }
    minimumTlsVersion: '1.2'
    enableNonSslPort: false
    publicNetworkAccess: usePrivateEndpoint ? 'Disabled' : 'Enabled'
    disableAccessKeyAuthentication: true
    redisConfiguration: {
      'aad-enabled': 'true'
    }
  }
}

resource classicAccess 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = if (!isManaged) {
  parent: classicRedis
  name: 'app-identity'
  properties: {
    accessPolicyName: 'Data Contributor'
    objectId: principalId
    objectIdAlias: principalName
  }
}

module privateEndpoint 'private-endpoint.bicep' = if (usePrivateEndpoint) {
  name: 'pe-redis'
  params: {
    location: location
    name: 'pe-${name}'
    tags: tags
    subnetId: privateEndpointSubnetId
    privateLinkServiceId: isManaged ? managedRedis.id : classicRedis.id
    groupId: isManaged ? 'redisEnterprise' : 'redisCache'
    privateDnsZoneIds: [
      privateDnsZoneId
    ]
  }
}

resource managedMetrics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled && isManaged) {
  name: 'send-to-log-analytics'
  scope: managedRedis
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

resource managedLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled && isManaged) {
  name: 'send-to-log-analytics'
  scope: managedDatabase
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
  }
}

resource classicDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled && !isManaged) {
  name: 'send-to-log-analytics'
  scope: classicRedis
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
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

@description('Resource id of the cache.')
output id string = isManaged ? managedRedis!.id : classicRedis!.id

@description('Cache name.')
output name string = name

@description('Cache host name.')
output hostName string = isManaged ? managedRedis!.properties.hostName : classicRedis!.properties.hostName
