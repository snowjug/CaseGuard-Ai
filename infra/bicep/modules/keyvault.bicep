// Key Vault (RBAC authorization, soft delete, purge protection) and the secrets the workloads reference.
// Secret values arrive as @secure() parameters or are read from sibling resources inside the deployment;
// nothing in this module is returned as an output except secret URIs (identifiers, not values).

@description('Azure region.')
param location string

@description('Key Vault name: 3-24 characters, letters/digits/hyphens, starts with a letter, no consecutive hyphens.')
@minLength(3)
@maxLength(24)
param name string

@description('Tags applied to every resource in this module.')
param tags object

@description('Microsoft Entra tenant id that owns the vault.')
param tenantId string = tenant().tenantId

@description('Soft delete retention in days (7-90). Cannot be changed after the vault is created.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionDays int = 90

@description('Enable purge protection (irreversible once on). When on, a deleted vault name stays reserved for the retention period.')
param enablePurgeProtection bool = true

@description('Create a private endpoint and disable public network access. Requires privateEndpointSubnetId and privateDnsZoneId.')
param usePrivateEndpoint bool = false

@description('Subnet for the private endpoint (used when usePrivateEndpoint is true).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id for privatelink.vaultcore.azure.net (used when usePrivateEndpoint is true).')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource id for diagnostic settings.')
param workspaceId string

@description('Send logs and metrics to Log Analytics.')
param diagnosticsEnabled bool = true

@description('Application Insights component whose connection string is stored as a secret.')
param appInsightsName string

@description('Create the database credential secrets (database-url and postgres-admin-password). Only true for PostgreSQL password authentication.')
param storeDatabaseCredentials bool = false

@description('Full PostgreSQL connection URL including the password. Stored as secret database-url.')
@secure()
param databaseUrl string = ''

@description('PostgreSQL administrator password. Stored as secret postgres-admin-password for operators and rotation.')
@secure()
param postgresAdminPassword string = ''

resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionDays
    // The API rejects an explicit false; omitting the property leaves purge protection off.
    enablePurgeProtection: enablePurgeProtection ? true : null
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    publicNetworkAccess: usePrivateEndpoint ? 'Disabled' : 'Enabled'
    networkAcls: {
      // Container Apps is not a trusted Key Vault service, so a public vault cannot be firewalled to
      // deny-by-default without breaking secret references. Private networking closes it properly.
      defaultAction: usePrivateEndpoint ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = if (storeDatabaseCredentials) {
  parent: vault
  name: 'database-url'
  properties: {
    value: databaseUrl
    contentType: 'text/plain'
  }
}

resource postgresPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = if (storeDatabaseCredentials) {
  parent: vault
  name: 'postgres-admin-password'
  properties: {
    value: postgresAdminPassword
    contentType: 'text/plain'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource appInsightsSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'appinsights-connection-string'
  properties: {
    value: appInsights.properties.ConnectionString
    contentType: 'text/plain'
  }
}

module privateEndpoint 'private-endpoint.bicep' = if (usePrivateEndpoint) {
  name: 'pe-keyvault'
  params: {
    location: location
    name: 'pe-${name}'
    tags: tags
    subnetId: privateEndpointSubnetId
    privateLinkServiceId: vault.id
    groupId: 'vault'
    privateDnsZoneIds: [
      privateDnsZoneId
    ]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (diagnosticsEnabled) {
  name: 'send-to-log-analytics'
  scope: vault
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

@description('Resource id of the vault.')
output id string = vault.id

@description('Vault name.')
output name string = vault.name

@description('Vault URI, for example for SDK clients.')
output vaultUri string = vault.properties.vaultUri

@description('Versionless secret URI of database-url (empty when not stored). Container Apps keyVaultUrl value.')
output databaseUrlSecretUri string = storeDatabaseCredentials ? '${vault.properties.vaultUri}secrets/database-url' : ''

@description('Versionless secret URI of the Application Insights connection string.')
output appInsightsSecretUri string = '${vault.properties.vaultUri}secrets/appinsights-connection-string'
