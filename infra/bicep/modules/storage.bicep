// Storage account for case artefacts: private container `cases`, TLS 1.2+, no anonymous access, no shared keys
// (Entra/RBAC only), soft delete, and a lifecycle policy that tiers and expires blobs.
//
// Lifecycle deletion removes blobs the database may still reference. Align blobDeleteAfterDays with the
// application's data-retention policy before enabling it for anything but synthetic demo data.

@description('Azure region.')
param location string

@description('Storage account name: 3-24 characters, lowercase letters and digits only, globally unique.')
@minLength(3)
@maxLength(24)
param name string

@description('Tags applied to every resource in this module.')
param tags object

@description('Replication SKU. Standard_LRS is the cheapest; use ZRS/GRS variants when durability requirements justify the cost.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_GZRS'
])
param skuName string = 'Standard_LRS'

@description('Name of the private blob container.')
param containerName string = 'cases'

@description('Move blobs to the Cool tier this many days after last modification (0 disables). Cool has a minimum retention charge: see docs/COST_GUIDE.md.')
@minValue(0)
param coolAfterDays int = 30

@description('Delete blobs this many days after last modification (0 disables). Must be greater than coolAfterDays when both are set.')
@minValue(0)
param deleteAfterDays int = 0

@description('Blob and container soft delete retention in days (1-365).')
@minValue(1)
@maxValue(365)
param softDeleteDays int = 7

@description('Create a private endpoint and disable public network access. Requires privateEndpointSubnetId and privateDnsZoneId.')
param usePrivateEndpoint bool = false

@description('Subnet for the private endpoint (used when usePrivateEndpoint is true).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id for privatelink.blob.<storage suffix> (used when usePrivateEndpoint is true).')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

var lifecycleEnabled = coolAfterDays > 0 || deleteAfterDays > 0

resource account 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    isHnsEnabled: false
    isSftpEnabled: false
    isLocalUserEnabled: false
    publicNetworkAccess: usePrivateEndpoint ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: usePrivateEndpoint ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: softDeleteDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: softDeleteDays
    }
  }
}

resource casesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2025-06-01' = if (lifecycleEnabled) {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'cases-tier-and-expire'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${containerName}/'
              ]
            }
            actions: {
              baseBlob: {
                tierToCool: coolAfterDays > 0
                  ? {
                      daysAfterModificationGreaterThan: coolAfterDays
                    }
                  : null
                delete: deleteAfterDays > 0
                  ? {
                      daysAfterModificationGreaterThan: deleteAfterDays
                    }
                  : null
              }
            }
          }
        }
      ]
    }
  }
}

module privateEndpoint 'private-endpoint.bicep' = if (usePrivateEndpoint) {
  name: 'pe-blob'
  params: {
    location: location
    name: 'pe-${name}-blob'
    tags: tags
    subnetId: privateEndpointSubnetId
    privateLinkServiceId: account.id
    groupId: 'blob'
    privateDnsZoneIds: [
      privateDnsZoneId
    ]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: blobService
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
        category: 'Transaction'
        enabled: true
      }
      {
        category: 'Capacity'
        enabled: true
      }
    ]
  }
}

@description('Resource id of the storage account.')
output id string = account.id

@description('Storage account name (AZURE_STORAGE_ACCOUNT).')
output name string = account.name

@description('Resource id of the private blob container, used to scope the data-plane role assignment.')
output containerId string = casesContainer.id

@description('Container name (AZURE_STORAGE_CONTAINER).')
output containerName string = casesContainer.name
