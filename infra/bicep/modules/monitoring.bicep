// Log Analytics workspace + workspace-based Application Insights.
//
// No diagnostic settings are attached to either resource on purpose: Application Insights is
// workspace-based (its telemetry already lands in the workspace, so exporting it again would
// double the ingestion), and a workspace that exports to itself adds cost without value.

@description('Azure region.')
param location string

@description('Log Analytics workspace name (4-63 characters).')
@minLength(4)
@maxLength(63)
param workspaceName string

@description('Application Insights component name.')
@minLength(1)
@maxLength(260)
param appInsightsName string

@description('Tags applied to every resource in this module.')
param tags object

@description('Interactive retention of the workspace in days. Longer retention increases cost.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

@description('Daily ingestion cap in GB (whole numbers). -1 disables the cap. When the cap is reached ingestion stops until the next UTC day, including security-relevant logs.')
@minValue(-1)
param dailyCapGb int = -1

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      // Query access follows the permissions of the resource being queried, not workspace-wide reader.
      enableLogAccessUsingOnlyResourcePermissions: true
      // Shared-key (local) authentication is off; diagnostic settings and Application Insights do not need it.
      disableLocalAuth: true
    }
    workspaceCapping: {
      dailyQuotaGb: dailyCapGb
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

@description('Resource id of the Log Analytics workspace.')
output workspaceId string = workspace.id

@description('Name of the Log Analytics workspace.')
output workspaceName string = workspace.name

@description('Resource id of the Application Insights component.')
output appInsightsId string = appInsights.id

@description('Name of the Application Insights component.')
output appInsightsName string = appInsights.name
