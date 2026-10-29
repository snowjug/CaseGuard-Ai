// Azure AI Search (optional). Key (local) authentication is disabled: clients use Entra ID with the
// "Search Index Data Contributor" role that rbac.bicep grants to the managed identity.
//
// Tier limitations (verify against the current Azure AI Search limits page before choosing a SKU):
//   free   - one per subscription, shared capacity, tight storage/index/document limits, no scaling,
//            no private endpoints, no SLA. Fine for a smoke test, not for evaluation data.
//   basic  - first tier with private endpoints and replicas; the sensible dev/demo default.
//   standard and above - for real capacity; cost grows with replicas x partitions.
// Creating the `caseguard` index itself is a data-plane operation (Search Service Contributor); this template
// does not create it and does not grant the application identity that right.

@description('Azure region. Not every region has capacity for every tier.')
param location string

@description('Search service name: 2-60 characters, lowercase letters, digits and dashes, not starting or ending with a dash.')
@minLength(2)
@maxLength(60)
param name string

@description('Tags applied to every resource in this module.')
param tags object

@description('Pricing tier. See the tier notes at the top of this file.')
@allowed([
  'free'
  'basic'
  'standard'
  'standard2'
  'standard3'
  'storage_optimized_l1'
  'storage_optimized_l2'
])
param skuName string = 'basic'

@description('Replica count (1-12). Ignored on the free tier. Multiple replicas multiply cost.')
@minValue(1)
@maxValue(12)
param replicaCount int = 1

@description('Partition count. Ignored on the free tier.')
@allowed([
  1
  2
  3
  4
  6
  12
])
param partitionCount int = 1

@description('Create a private endpoint and disable public network access. Not available on the free tier.')
param usePrivateEndpoint bool = false

@description('Subnet for the private endpoint (used when usePrivateEndpoint is true).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id for privatelink.search.windows.net (used when usePrivateEndpoint is true).')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

var isFree = skuName == 'free'

// Public-cloud DNS suffix; sovereign clouds use a different one (and different private DNS zone names).
var searchDnsSuffix = 'search.windows.net'

// Evaluated through the publicNetworkAccess expression below so an impossible combination fails at deployment start.
var tierSupportsPrivateEndpoint = usePrivateEndpoint && isFree
  ? fail('The Azure AI Search free tier does not support private endpoints. Use basic or higher with private networking.')
  : true

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    hostingMode: 'Default'
    replicaCount: isFree ? 1 : replicaCount
    partitionCount: isFree ? 1 : partitionCount
    publicNetworkAccess: usePrivateEndpoint && tierSupportsPrivateEndpoint ? 'disabled' : 'enabled'
    disableLocalAuth: true
    semanticSearch: 'disabled'
  }
}

module privateEndpoint 'private-endpoint.bicep' = if (usePrivateEndpoint) {
  name: 'pe-search'
  params: {
    location: location
    name: 'pe-${name}'
    tags: tags
    subnetId: privateEndpointSubnetId
    privateLinkServiceId: search.id
    groupId: 'searchService'
    privateDnsZoneIds: [
      privateDnsZoneId
    ]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: search
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

@description('Resource id of the search service.')
output id string = search.id

@description('Search service name.')
output name string = search.name

@description('Search endpoint (AZURE_SEARCH_ENDPOINT).')
output endpoint string = 'https://${search.name}.${searchDnsSuffix}'
