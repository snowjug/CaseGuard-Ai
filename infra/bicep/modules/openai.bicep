// Azure OpenAI account (optional; main.bicep only deploys this module when deployOpenAi is true).
//
// !!! READ BEFORE ENABLING deployModel !!!
// Creating an Azure OpenAI account does not give you a usable model. A model deployment needs ALL of:
//   * access to Azure OpenAI for the subscription (approval can be required),
//   * the chosen model + version to be offered in this region for the chosen deployment SKU,
//   * enough quota (tokens-per-minute) for that model/SKU/region in this subscription.
// Model names, versions, SKUs and quotas change often and differ per region, so none are defaulted here: you must
// supply them after checking the current model availability and your quota in the Azure portal or docs.
// If any requirement is not met the deployment of this resource fails (typically InsufficientQuota,
// SkuNotSupported or ModelNotFound) and rolls back only that resource. Keep deployModel=false and create the model
// deployment by hand (or reference an existing account) when in doubt.
// Account deletion is soft: the name and custom subdomain stay reserved until the soft-deleted account is purged.

@description('Azure region. Model availability and quota are regional.')
param location string

@description('Account name; also used as the custom subdomain (2-64 characters, letters, digits and hyphens).')
@minLength(2)
@maxLength(64)
param name string

@description('Tags applied to every resource in this module.')
param tags object

@description('Create a model deployment. Off by default; see the warning at the top of this file.')
param deployModel bool = false

@description('Deployment name the application uses (AZURE_OPENAI_DEPLOYMENT).')
@minLength(1)
@maxLength(64)
param deploymentName string = 'caseguard-chat'

@description('Model name, for example a chat-capable model offered in your region. Required when deployModel is true.')
param modelName string = ''

@description('Model version string as offered in your region. Required when deployModel is true.')
param modelVersion string = ''

@description('Deployment SKU: Standard (regional pay-as-you-go), GlobalStandard, DataZoneStandard or ProvisionedManaged. Availability depends on the model and region.')
@allowed([
  'Standard'
  'GlobalStandard'
  'DataZoneStandard'
  'ProvisionedManaged'
])
param modelSkuName string = 'Standard'

@description('Capacity of the deployment (thousands of tokens per minute for pay-as-you-go SKUs). Must fit your quota. Keep small: it also bounds spend.')
@minValue(1)
param modelCapacity int = 10

@description('Create a private endpoint and disable public network access. Requires privateEndpointSubnetId and privateDnsZoneIds.')
param usePrivateEndpoint bool = false

@description('Subnet for the private endpoint (used when usePrivateEndpoint is true).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone ids (privatelink.openai.azure.com and privatelink.cognitiveservices.azure.com), used when usePrivateEndpoint is true.')
param privateDnsZoneIds array = []

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

var modelSettingsOk = deployModel && (empty(modelName) || empty(modelVersion))
  ? fail('modelName and modelVersion are required when deployModel is true. Check current availability and quota first.')
  : true

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: name
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: name
    publicNetworkAccess: usePrivateEndpoint ? 'Disabled' : 'Enabled'
    // API keys are disabled: the application authenticates with its managed identity.
    disableLocalAuth: true
    networkAcls: {
      defaultAction: usePrivateEndpoint ? 'Deny' : 'Allow'
    }
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = if (deployModel && modelSettingsOk) {
  parent: account
  name: deploymentName
  sku: {
    name: modelSkuName
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    // Pinned on purpose: silent model upgrades would change behaviour behind recorded prompt versions.
    versionUpgradeOption: 'NoAutoUpgrade'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

module privateEndpoint 'private-endpoint.bicep' = if (usePrivateEndpoint) {
  name: 'pe-openai'
  params: {
    location: location
    name: 'pe-${name}'
    tags: tags
    subnetId: privateEndpointSubnetId
    privateLinkServiceId: account.id
    groupId: 'account'
    privateDnsZoneIds: privateDnsZoneIds
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: account
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

@description('Resource id of the account.')
output id string = account.id

@description('Account name.')
output name string = account.name

@description('Endpoint of the account (AZURE_OPENAI_ENDPOINT).')
output endpoint string = account.properties.endpoint

@description('Deployment name the application should use. The deployment only exists when deployModel is true.')
output deploymentName string = deploymentName
