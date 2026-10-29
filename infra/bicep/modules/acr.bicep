// Azure Container Registry. The admin user is always disabled: Container Apps pulls with the managed identity (AcrPull)
// and humans/CI authenticate with Entra ID (az acr login / az acr build).
//
// Private networking: a private endpoint needs the Premium SKU, so this module deliberately keeps the registry endpoint
// public (Entra-authenticated, anonymous pull off). Upgrade to Premium and add a private endpoint if your policy requires it.

@description('Azure region.')
param location string

@description('Registry name: 5-50 characters, lowercase letters and digits only, globally unique.')
@minLength(5)
@maxLength(50)
param name string

@description('Tags applied to the registry.')
param tags object

@description('Registry SKU. Basic is enough for a dev/demo; Premium adds private endpoints, geo-replication, zone redundancy and the untagged-manifest retention policy.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Basic'

@description('Days after which untagged manifests are purged (Premium SKU only; 0 disables).')
@minValue(0)
@maxValue(365)
param untaggedRetentionDays int = 7

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

var retentionEnabled = sku == 'Premium' && untaggedRetentionDays > 0

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
    policies: {
      azureADAuthenticationAsArmPolicy: {
        status: 'enabled'
      }
      retentionPolicy: retentionEnabled
        ? {
            status: 'enabled'
            days: untaggedRetentionDays
          }
        : null
    }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: registry
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

@description('Resource id of the registry.')
output id string = registry.id

@description('Registry name (used by az acr build).')
output name string = registry.name

@description('Registry login server host name.')
output loginServer string = registry.properties.loginServer
