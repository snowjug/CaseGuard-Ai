<#
.SYNOPSIS
  Shows what a CaseGuard AI deployment WOULD change (az deployment sub what-if). Read-only, but it still talks to Azure.

.DESCRIPTION
  Prints the target subscription, resource group and environment, asks for confirmation, then runs a What-If of
  infra/bicep/main.bicep with the selected parameter file. Nothing is created, changed or deleted.

  The subscription is never inferred: -SubscriptionId (or CASEGUARD_SUBSCRIPTION_ID) is required, a placeholder id is
  refused, and the parameter file must not contain placeholder values.

  What-If of the stage-2 deployment (apps and migration job) needs the images to exist only by tag name, so pass
  -DeployApps -ImageTag <tag> to preview that stage.

.PARAMETER SubscriptionId
  Target subscription id (GUID). Falls back to $env:CASEGUARD_SUBSCRIPTION_ID. Never defaults to the az current subscription.

.PARAMETER Location
  Azure region used as the deployment location and as the default for resources (for example westeurope).

.PARAMETER Environment
  dev, staging or prod. Selects main.<env>.local.bicepparam, else main.dev.bicepparam for dev.

.PARAMETER ParameterFile
  Explicit parameter file. Overrides the environment default.

.PARAMETER WorkloadName
  Must equal the workloadName parameter of the deployment (default caseguard). Only used to show the resource group name.

.PARAMETER DeployApps
  Preview the stage that creates the Container Apps and the migration job (needs -ImageTag).

.PARAMETER ImageTag
  Immutable image tag for the apps (with -DeployApps).

.PARAMETER AssumeYes
  Skip the typed confirmation of this read-only command (for CI). Never used by deploy or destroy scripts.

.EXAMPLE
  .\infra\scripts\what-if.ps1 -SubscriptionId <subscription-guid> -Location westeurope

.NOTES
  The Postgres admin password is read from CASEGUARD_POSTGRES_ADMIN_PASSWORD. For a What-If only, a throw-away random
  value is generated when it is not set; it is never stored or sent anywhere that persists.
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = $env:CASEGUARD_SUBSCRIPTION_ID,
    [Parameter(Mandatory = $true)][string]$Location,
    [ValidateSet('dev', 'staging', 'prod')][string]$Environment = 'dev',
    [string]$ParameterFile = '',
    [string]$WorkloadName = 'caseguard',
    [switch]$DeployApps,
    [string]$ImageTag = '',
    [switch]$AssumeYes
)

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-CgAzureCli
Assert-CgSubscriptionId -SubscriptionId $SubscriptionId

$paths = Get-CgPaths
$paramFile = Resolve-CgParameterFile -BicepDir $paths.BicepDir -Environment $Environment -ParameterFile $ParameterFile
Assert-CgNoPlaceholders -Path $paramFile

if ($DeployApps -and [string]::IsNullOrWhiteSpace($ImageTag)) {
    throw '-DeployApps requires -ImageTag.'
}

$subscription = Get-CgTargetSubscription -SubscriptionId $SubscriptionId
$resourceGroup = Get-CgResourceGroupName -WorkloadName $WorkloadName -Environment $Environment
$stage = if ($DeployApps) { 'stage 2 (apps + migration job)' } else { 'stage 1 (infrastructure only)' }

Show-CgTarget -Action "WHAT-IF (read-only) of $stage" -Subscription $subscription -ResourceGroup $resourceGroup `
    -Environment $Environment -Location $Location -Details @("Parameter file  : $paramFile")

if ($Environment -eq 'prod') {
    Write-Host 'PRODUCTION target. What-If changes nothing, but review the result with your change approver.' -ForegroundColor Red
}

if (-not $AssumeYes) {
    Confirm-CgTarget -Prompt 'Type yes to run the What-If' -ExpectedText 'yes'
}

$envBackup = @{
    CASEGUARD_DEPLOY_APPS            = $env:CASEGUARD_DEPLOY_APPS
    CASEGUARD_IMAGE_TAG              = $env:CASEGUARD_IMAGE_TAG
    CASEGUARD_POSTGRES_ADMIN_PASSWORD = $env:CASEGUARD_POSTGRES_ADMIN_PASSWORD
}
try {
    $env:CASEGUARD_DEPLOY_APPS = if ($DeployApps) { 'true' } else { 'false' }
    $env:CASEGUARD_IMAGE_TAG = $ImageTag
    if ([string]::IsNullOrEmpty($env:CASEGUARD_POSTGRES_ADMIN_PASSWORD)) {
        $env:CASEGUARD_POSTGRES_ADMIN_PASSWORD = New-CgRandomPassword -Length 32
    }

    $deploymentName = 'caseguard-{0}-whatif-{1}' -f $Environment, (Get-Date -Format 'yyyyMMddHHmmss')
    Write-Host ("Running what-if '{0}' ..." -f $deploymentName)
    & az deployment sub what-if `
        --subscription $subscription.Id `
        --location $Location `
        --name $deploymentName `
        --parameters $paramFile
    if ($LASTEXITCODE -ne 0) { throw "az deployment sub what-if failed with exit code $LASTEXITCODE." }
    Write-Host 'What-If finished. Nothing was changed.' -ForegroundColor Green
}
finally {
    foreach ($name in $envBackup.Keys) {
        if ($null -eq $envBackup[$name]) {
            Remove-Item -Path ("Env:{0}" -f $name) -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -Path ("Env:{0}" -f $name) -Value $envBackup[$name]
        }
    }
}
