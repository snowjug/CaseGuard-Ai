// User-assigned managed identity shared by the web app, the API and the migration job.
// One identity keeps the role assignments auditable; split it per workload if blast-radius
// separation between web and API becomes a requirement.

@description('Azure region.')
param location string

@description('Managed identity name (3-128 characters).')
@minLength(3)
@maxLength(128)
param name string

@description('Tags applied to the identity.')
param tags object

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: name
  location: location
  tags: tags
}

@description('Resource id of the identity.')
output id string = identity.id

@description('Name of the identity (also the PostgreSQL role name when Entra authentication is used).')
output name string = identity.name

@description('Client (application) id, used as AZURE_CLIENT_ID so DefaultAzureCredential selects this identity.')
output clientId string = identity.properties.clientId

@description('Object (principal) id used for role assignments and as the PostgreSQL Entra administrator.')
output principalId string = identity.properties.principalId
