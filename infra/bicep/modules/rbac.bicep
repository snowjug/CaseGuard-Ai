// Least-privilege role assignments for the shared managed identity on resources inside the workload resource group.
// Every assignment is scoped to the single resource it needs (the blob one to the `cases` container).
// Role ids are Azure built-in roles; they are stable GUIDs and are verified by name in the comments.

@description('Object (principal) id of the managed identity.')
param principalId string

@description('Name of the container registry (role: AcrPull).')
param registryName string

@description('Name of the Key Vault (role: Key Vault Secrets User).')
param keyVaultName string

@description('Name of the storage account that holds the container.')
param storageAccountName string

@description('Name of the private blob container (role: Storage Blob Data Contributor, scoped to the container).')
param storageContainerName string

@description('Name of the AI Search service (role: Search Index Data Contributor). Empty skips the assignment.')
param searchServiceName string = ''

@description('Name of an Azure OpenAI account in this resource group (role: Cognitive Services OpenAI User). Empty skips the assignment.')
param openAiAccountName string = ''

var roleIds = {
  // AcrPull
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  // Key Vault Secrets User
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  // Storage Blob Data Contributor
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  // Search Index Data Contributor
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  // Cognitive Services OpenAI User
  openAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}

resource keyVault 'Microsoft.KeyVault/vaults@2025-05-01' existing = {
  name: keyVaultName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-06-01' existing = {
  name: storageAccountName

  resource blobService 'blobServices' existing = {
    name: 'default'

    resource casesContainer 'containers' existing = {
      name: storageContainerName
    }
  }
}

resource searchService 'Microsoft.Search/searchServices@2025-05-01' existing = if (!empty(searchServiceName)) {
  name: searchServiceName
}

resource openAiAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = if (!empty(openAiAccountName)) {
  name: openAiAccountName
}

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, roleIds.acrPull)
  scope: registry
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.acrPull)
  }
}

resource keyVaultSecretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, principalId, roleIds.keyVaultSecretsUser)
  scope: keyVault
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsUser)
  }
}

resource blobContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount::blobService::casesContainer.id, principalId, roleIds.storageBlobDataContributor)
  scope: storageAccount::blobService::casesContainer
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.storageBlobDataContributor
    )
  }
}

resource searchIndexDataContributorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(searchServiceName)) {
  name: guid(searchService.id, principalId, roleIds.searchIndexDataContributor)
  scope: searchService
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.searchIndexDataContributor
    )
  }
}

resource openAiUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(openAiAccountName)) {
  name: guid(openAiAccount.id, principalId, roleIds.openAiUser)
  scope: openAiAccount
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.openAiUser)
  }
}
