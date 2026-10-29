// Optional private networking: one VNet with a delegated Container Apps subnet, a private endpoint subnet,
// and the private DNS zones (linked to the VNet) that the private endpoints register into.
//
// Not included on purpose (documented in infra/bicep/README.md): NSGs/UDRs/egress firewall, VNet peering,
// Azure Monitor Private Link Scope and a private endpoint for the container registry (needs the Premium SKU).

@description('Azure region.')
param location string

@description('Virtual network name (2-64 characters).')
@minLength(2)
@maxLength(64)
param vnetName string

@description('Tags applied to every resource in this module.')
param tags object

@description('Address space of the VNet.')
param addressPrefix string = '10.40.0.0/16'

@description('Subnet for the Container Apps environment (delegated to Microsoft.App/environments). A /27 or larger is required for workload-profile environments; /23 leaves room to scale.')
param containerAppsSubnetPrefix string = '10.40.0.0/23'

@description('Subnet that holds the private endpoint network interfaces.')
param privateEndpointSubnetPrefix string = '10.40.2.0/26'

@description('Private DNS zones to create and link, as objects with a lookup key and a zone name.')
param privateDnsZones array

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-containerapps'
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for zone in privateDnsZones: {
    name: zone.name
    location: 'global'
    tags: tags
  }
]

resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (zone, index) in privateDnsZones: {
    parent: zones[index]
    name: 'link-${vnetName}'
    location: 'global'
    tags: tags
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: vnet.id
      }
    }
  }
]

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: vnet
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

@description('Resource ids keyed by a lookup name.')
type idMap = {
  *: string
}

@description('Resource id of the VNet.')
output vnetId string = vnet.id

@description('Resource id of the delegated Container Apps subnet.')
output containerAppsSubnetId string = vnet.properties.subnets[0].id

@description('Resource id of the private endpoint subnet.')
output privateEndpointSubnetId string = vnet.properties.subnets[1].id

@description('Private DNS zone resource ids keyed by the lookup key supplied in privateDnsZones.')
output privateDnsZoneIds idMap = toObject(
  privateDnsZones,
  zone => zone.key,
  zone => resourceId('Microsoft.Network/privateDnsZones', zone.name)
)
