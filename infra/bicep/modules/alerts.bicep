// Action group (e-mail) and metric alerts for the API: server errors and response time.
// Both alerts use Container Apps platform metrics, so they work without application instrumentation.
// A scaled-to-zero API reports no data, which keeps these alerts quiet instead of firing on silence.
//
// Verify after the first deployment (portal > API app > Metrics) that the metric names, the statusCodeCategory
// dimension values and the Preview status of ResponseTime still match; metric definitions are not validated at
// compile time.

@description('Tags applied to the alert resources.')
param tags object

@description('Action group name.')
@minLength(1)
@maxLength(260)
param actionGroupName string

@description('Action group short name (at most 12 characters, shown in SMS/e-mail).')
@minLength(1)
@maxLength(12)
param actionGroupShortName string

@description('E-mail addresses notified by the action group.')
@minLength(1)
param emailAddresses array

@description('Resource id of the API container app that the alerts monitor.')
param apiAppId string

@description('Prefix for the alert rule names.')
@minLength(1)
@maxLength(80)
param alertNamePrefix string

@description('Number of 5xx responses in the 15-minute window that triggers the alert.')
@minValue(1)
param serverErrorThreshold int = 5

@description('Average response time in milliseconds over the 15-minute window that triggers the alert.')
@minValue(1)
param responseTimeThresholdMs int = 2000

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'global'
  tags: tags
  properties: {
    groupShortName: actionGroupShortName
    enabled: true
    emailReceivers: [
      for (address, index) in emailAddresses: {
        name: 'email-${index}'
        emailAddress: address
        useCommonAlertSchema: true
      }
    ]
  }
}

resource serverErrorAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${alertNamePrefix}-api-5xx'
  location: 'global'
  tags: tags
  properties: {
    description: 'The API returned more 5xx responses than the threshold in the last 15 minutes. See docs/runbooks.'
    severity: 2
    enabled: true
    scopes: [
      apiAppId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ServerErrors'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: [
                '5xx'
              ]
            }
          ]
          operator: 'GreaterThan'
          threshold: serverErrorThreshold
          timeAggregation: 'Total'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

resource latencyAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${alertNamePrefix}-api-latency'
  location: 'global'
  tags: tags
  properties: {
    description: 'Average API response time exceeded the threshold over the last 15 minutes. See docs/runbooks.'
    severity: 3
    enabled: true
    scopes: [
      apiAppId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ResponseTime'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'ResponseTime'
          operator: 'GreaterThan'
          threshold: responseTimeThresholdMs
          timeAggregation: 'Average'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

@description('Resource id of the action group.')
output actionGroupId string = actionGroup.id
