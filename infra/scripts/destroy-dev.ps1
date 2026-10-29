<#
.SYNOPSIS
  DESTRUCTIVE: deletes the CaseGuard AI DEV resource group and everything in it.

.DESCRIPTION
  Deletes by resource group only (az group delete); no individual resource is deleted by this script.

  Safety rules, all checked before anything is deleted:
    * the subscription is explicit (-SubscriptionId or CASEGUARD_SUBSCRIPTION_ID); a placeholder id is refused;
    * the resource group name must start with rg-<workload>- and END WITH -dev;
    * the resource group must carry the tags application=caseguard and environment=dev (created by main.bicep);
    * the group must not have management locks (remove locks deliberately, outside this script);
    * the target and the resources about to be deleted are listed, and you must type the EXACT resource group name.
  Use -WhatIf for a dry run that performs only the read-only checks and prints what would be deleted.

  Key Vault, Azure OpenAI and Log Analytics use soft delete: after the group is gone their names stay reserved until the
  retention period ends. -PurgeSoftDeleted purges the soft-deleted Key Vault (only if purge protection is off) and Azure
  OpenAI account that belonged to this group. It never purges anything else. Alternatively change nameSalt on the next
  deployment to get fresh names.

.PARAMETER SubscriptionId
  Target subscription id (GUID). Falls back to $env:CASEGUARD_SUBSCRIPTION_ID. Never defaults to the az current subscription.

.PARAMETER ResourceGroupName
  Resource group to delete. Default rg-caseguard-dev.

.PARAMETER WorkloadName
  Workload name used in the resource group prefix. Default caseguard.

.PARAMETER ConfirmResourceGroupName
  Pre-supplied confirmation for automation. Must equal the resource group name exactly.

.PARAMETER PurgeSoftDeleted
  After deletion, purge soft-deleted Key Vault and Azure OpenAI remnants of this group where the service allows it.

.PARAMETER NoWait
  Do not wait for the deletion to finish (this also skips the purge step).

.EXAMPLE
  .\infra\scripts\destroy-dev.ps1 -SubscriptionId <subscription-guid> -WhatIf

.EXAMPLE
  .\infra\scripts\destroy-dev.ps1 -SubscriptionId <subscription-guid> -PurgeSoftDeleted
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$SubscriptionId = $env:CASEGUARD_SUBSCRIPTION_ID,
    [string]$ResourceGroupName = 'rg-caseguard-dev',
    [string]$WorkloadName = 'caseguard',
    [string]$ConfirmResourceGroupName = '',
    [switch]$PurgeSoftDeleted,
    [switch]$NoWait
)

. (Join-Path $PSScriptRoot 'common.ps1')

function Get-CgTag {
    param($Group, [string]$Name)
    $property = $Group.PSObject.Properties['tags']
    if ($null -eq $property -or $null -eq $property.Value) { return '' }
    $tag = $property.Value.PSObject.Properties[$Name]
    if ($null -eq $tag) { return '' }
    return "$($tag.Value)"
}

Assert-CgAzureCli
Assert-CgSubscriptionId -SubscriptionId $SubscriptionId

# Name rules first: they need no Azure call at all.
if ($ResourceGroupName -notmatch '^[a-z0-9][a-z0-9-]*$') {
    throw "Refusing: '$ResourceGroupName' is not a plain resource group name."
}
if (-not $ResourceGroupName.EndsWith('-dev')) {
    throw "Refusing: '$ResourceGroupName' does not end with -dev. This script only deletes DEV environments."
}
$requiredPrefix = "rg-$WorkloadName-"
if (-not $ResourceGroupName.StartsWith($requiredPrefix)) {
    throw "Refusing: '$ResourceGroupName' does not start with '$requiredPrefix', the CaseGuard naming convention."
}

$subscription = Get-CgTargetSubscription -SubscriptionId $SubscriptionId

$groupJson = Invoke-CgAz -Arguments @('group', 'show', '--subscription', $subscription.Id, '--name', $ResourceGroupName, '--output', 'json') -AllowFailure
if (-not $groupJson) {
    Write-Host "Resource group '$ResourceGroupName' does not exist in '$($subscription.Name)'. Nothing to delete."
    return
}
$group = $groupJson | ConvertFrom-Json

if ((Get-CgTag -Group $group -Name 'application') -ne 'caseguard') {
    throw "Refusing: '$ResourceGroupName' lacks the tag application=caseguard, so it was not created by this repository's templates."
}
if ((Get-CgTag -Group $group -Name 'environment') -ne 'dev') {
    throw "Refusing: '$ResourceGroupName' lacks the tag environment=dev."
}

$locksJson = Invoke-CgAz -Arguments @('lock', 'list', '--subscription', $subscription.Id, '--resource-group', $ResourceGroupName, '--output', 'json')
$locks = ConvertFrom-CgJsonArray -Json $locksJson
if ($locks.Count -gt 0) {
    $names = ($locks | ForEach-Object { $_.name }) -join ', '
    throw "Refusing: the resource group (or resources in it) has management locks: $names. Remove them deliberately, then run this script again."
}

$resourcesJson = Invoke-CgAz -Arguments @('resource', 'list', '--subscription', $subscription.Id, '--resource-group', $ResourceGroupName, '--query', '[].{name:name,type:type}', '--output', 'json')
$resources = ConvertFrom-CgJsonArray -Json $resourcesJson

Show-CgTarget -Action 'DELETE THE ENTIRE RESOURCE GROUP (irreversible)' -Subscription $subscription -ResourceGroup $ResourceGroupName `
    -Environment 'dev' -Location $group.location -Details @("Resources in the group: $($resources.Count)")
foreach ($resource in $resources) {
    Write-Host ("  - {0}  [{1}]" -f $resource.name, $resource.type)
}
Write-Host ''

if ($WhatIfPreference) {
    Write-Host 'WhatIf: all safety checks passed. The resource group and the resources listed above would be deleted. Nothing was changed.' -ForegroundColor Yellow
    return
}

Confirm-CgTarget -Prompt "Type the resource group name ($ResourceGroupName) to DELETE it" -ExpectedText $ResourceGroupName -Provided $ConfirmResourceGroupName

if ($PSCmdlet.ShouldProcess("resource group $ResourceGroupName in subscription $($subscription.Name)", 'Delete')) {
    $deleteArguments = @('group', 'delete', '--subscription', $subscription.Id, '--name', $ResourceGroupName, '--yes')
    if ($NoWait) { $deleteArguments += '--no-wait' }
    Write-Host 'Deleting the resource group ...' -ForegroundColor Red
    Invoke-CgAz -Arguments $deleteArguments | Out-Null
    Write-Host 'Resource group deletion requested.' -ForegroundColor Green

    if ($NoWait) {
        Write-Host 'Not waiting (-NoWait): soft-deleted remnants were not checked.'
        return
    }

    $groupMarker = "/resourcegroups/$($ResourceGroupName.ToLowerInvariant())/"

    $vaultsJson = Invoke-CgAz -Arguments @('keyvault', 'list-deleted', '--subscription', $subscription.Id, '--resource-type', 'vault', '--output', 'json') -AllowFailure
    $vaults = @(ConvertFrom-CgJsonArray -Json $vaultsJson | Where-Object { $_ -and ("$($_.properties.vaultId)".ToLowerInvariant().Contains($groupMarker)) })
    foreach ($vault in $vaults) {
        if ($PurgeSoftDeleted -and -not $vault.properties.purgeProtectionEnabled) {
            Write-Host ("Purging soft-deleted Key Vault {0} ..." -f $vault.name)
            Invoke-CgAz -Arguments @('keyvault', 'purge', '--subscription', $subscription.Id, '--name', $vault.name, '--location', $vault.properties.location) | Out-Null
        }
        else {
            Write-Host ("Key Vault {0} is soft-deleted (purge protection: {1}); its name stays reserved until {2}. Use a new nameSalt to redeploy sooner." -f $vault.name, $vault.properties.purgeProtectionEnabled, $vault.properties.scheduledPurgeDate)
        }
    }

    $accountsJson = Invoke-CgAz -Arguments @('cognitiveservices', 'account', 'list-deleted', '--subscription', $subscription.Id, '--output', 'json') -AllowFailure
    $accounts = @(ConvertFrom-CgJsonArray -Json $accountsJson | Where-Object { $_ -and ("$($_.id)".ToLowerInvariant().Contains($groupMarker)) })
    foreach ($account in $accounts) {
        if ($PurgeSoftDeleted) {
            Write-Host ("Purging soft-deleted Azure OpenAI/Cognitive Services account {0} ..." -f $account.name)
            Invoke-CgAz -Arguments @('cognitiveservices', 'account', 'purge', '--subscription', $subscription.Id, '--name', $account.name, '--resource-group', $ResourceGroupName, '--location', $account.location) | Out-Null
        }
        else {
            Write-Host ("Account {0} is soft-deleted; its name and custom subdomain stay reserved until it is purged (re-run with -PurgeSoftDeleted or purge it manually)." -f $account.name)
        }
    }

    Write-Host 'Log Analytics workspaces are soft-deleted for 14 days: redeploying with the same names within that window needs a different nameSalt (or recover/force-delete the workspace manually).'
}
