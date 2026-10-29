// Role assignment on an EXISTING Azure OpenAI account that lives outside the workload resource group
// (possibly in another subscription). main.bicep deploys this module with the account's own resource group scope.
// The deploying principal needs permission to create role assignments on that account.

@description('Object (principal) id of the managed identity.')
param principalId string

@description('Name of the existing Azure OpenAI account in the resource group this module is scoped to.')
param accountName string

// Cognitive Services OpenAI User: call the model with Entra ID, no management or key access.
var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: accountName
}

resource openAiUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, openAiUserRoleId)
  scope: account
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
  }
}
