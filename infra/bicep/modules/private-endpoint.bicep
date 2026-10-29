// Generic private endpoint + private DNS zone group. Used by every data-plane module
// (Key Vault, Storage, PostgreSQL, AI Search, Azure OpenAI, Redis) so the pattern lives in one place.

@description('Azure region of the private endpoint (must match the region of the VNet).')
param location string

@description('Private endpoint resource name.')
@minLength(2)
@maxLength(80)
param name string

@description('Tags applied to the private endpoint.')
param tags object

@description('Resource id of the subnet that receives the private endpoint network interface.')
param subnetId string

@description('Resource id of the service the private endpoint connects to.')
param privateLinkServiceId string

@description('Sub-resource (group id) of the target service, for example vault, blob, postgresqlServer, searchService, account.')
param groupId string

@description('Private DNS zone resource ids that receive the A records of this endpoint.')
@minLength(1)
param privateDnsZoneIds array

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2025-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: privateLinkServiceId
          groupIds: [
            groupId
          ]
        }
      }
    ]
  }
}

resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-05-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      for (zoneId, index) in privateDnsZoneIds: {
        name: 'zone-${index}'
        properties: {
          privateDnsZoneId: zoneId
        }
      }
    ]
  }
}

@description('Resource id of the private endpoint.')
output id string = privateEndpoint.id
