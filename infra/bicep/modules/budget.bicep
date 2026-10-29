// Monthly cost budget on the workload resource group with threshold e-mail notifications.
// Budgets alert, they do not stop spending. Amounts are in the billing currency of the subscription's billing account.
// Deployed at resource-group scope, so it covers only this environment's resources.

@description('Budget name (1-63 characters).')
@minLength(1)
@maxLength(63)
param name string

@description('Monthly budget amount in the billing currency. Choose a number that matches your own tolerance; this template does not estimate costs.')
@minValue(1)
param amount int

@description('First day of the budget period (yyyy-MM-01). The service rejects other days and far-past or far-future dates.')
param startDate string

@description('Optional last day of the budget period (yyyy-MM-dd). Empty lets the service default to ten years after the start date.')
param endDate string = ''

@description('E-mail addresses that receive notifications.')
@minLength(1)
param contactEmails array

@description('Percentages of actual spend that trigger a notification (at most four).')
@maxLength(4)
param actualThresholds array = [
  50
  80
  100
]

@description('Percentage of forecasted spend that triggers a notification (0 disables). Forecasts need several days of usage history.')
@minValue(0)
param forecastThreshold int = 100

var actualNotifications = toObject(
  actualThresholds,
  threshold => 'Actual_GreaterThanOrEqualTo_${threshold}_Percent',
  threshold => {
    enabled: true
    operator: 'GreaterThanOrEqualTo'
    threshold: threshold
    thresholdType: 'Actual'
    contactEmails: contactEmails
    locale: 'en-us'
  }
)

var forecastNotifications = forecastThreshold > 0
  ? {
      'Forecasted_GreaterThanOrEqualTo_${forecastThreshold}_Percent': {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: forecastThreshold
        thresholdType: 'Forecasted'
        contactEmails: contactEmails
        locale: 'en-us'
      }
    }
  : {}

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: name
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
      endDate: empty(endDate) ? null : endDate
    }
    notifications: union(actualNotifications, forecastNotifications)
  }
}

@description('Resource id of the budget.')
output id string = budget.id
