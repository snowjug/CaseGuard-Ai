<#
.SYNOPSIS
  Deploys the CaseGuard AI DEV environment to Azure in two stages, runs the migration job and smoke-tests the result.

.DESCRIPTION
  THIS COMMAND CREATES BILLABLE AZURE RESOURCES. It is a helper for a human operator and has never been run against
  Azure from this repository. Run what-if.ps1 first and read docs/DEPLOYMENT.md.

  Flow (every az call is pinned to the explicit subscription; the az current subscription is never used or changed):
    1. Validate the target, the parameter file (no placeholders) and prerequisites; print the TARGET and require the
       resource group name to be typed.
    2. Stage 1: az deployment sub create with the Container Apps and job switched off (the registry is still empty).
    3. az acr build for the API and web images, tagged with an immutable tag.
    4. Stage 2: az deployment sub create with deployContainerApps=true and the image tag.
    5. Start the `migrate` job and wait for it to finish.
    6. Smoke test through the public web URL (the API has internal ingress only).
  Re-running is safe: deployments are declarative. Each run without -ImageTag builds new images.

.PARAMETER SubscriptionId
  Target subscription id (GUID). Falls back to $env:CASEGUARD_SUBSCRIPTION_ID. Never defaults to the az current subscription.

.PARAMETER Location
  Azure region (for example westeurope). Check SKU, quota and model availability first (docs/DEPLOYMENT.md).

.PARAMETER ParameterFile
  Parameter file. Default: infra/bicep/main.dev.local.bicepparam when it exists, else main.dev.bicepparam (which still
  holds placeholders and is therefore refused).

.PARAMETER WorkloadName
  Must equal the workloadName parameter used by the deployment (default caseguard).

.PARAMETER ImageTag
  Immutable tag for both images. Default: short git commit (plus a timestamp when the working tree is dirty).

.PARAMETER ApiDockerfile
  API Dockerfile, relative to the repository root (the build context).

.PARAMETER WebDockerfile
  Web Dockerfile, relative to the repository root.

.PARAMETER SkipImageBuild
  Reuse images that already exist in the registry under -ImageTag.

.PARAMETER SkipMigration
  Do not start the migration job (then the API stays not-ready until you run it).

.PARAMETER SkipSmokeTest
  Skip the HTTP smoke test.

.PARAMETER GeneratePostgresPassword
  Generate a random PostgreSQL administrator password for this run. It is stored only in Key Vault (never printed) and
  REPLACES the stored password on every run. Otherwise the password comes from CASEGUARD_POSTGRES_ADMIN_PASSWORD or a prompt.

.PARAMETER ConfirmResourceGroupName
  Pre-supplied confirmation for automation. Must equal the resource group name exactly.

.PARAMETER RbacPropagationSeconds
  Pause between the image build and stage 2 so the role assignments created in stage 1 can propagate (default 60).

.EXAMPLE
  .\infra\scripts\deploy-dev.ps1 -SubscriptionId <subscription-guid> -Location westeurope -GeneratePostgresPassword
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = $env:CASEGUARD_SUBSCRIPTION_ID,
    [Parameter(Mandatory = $true)][string]$Location,
    [string]$ParameterFile = '',
    [string]$WorkloadName = 'caseguard',
    [string]$ImageTag = '',
    [string]$ApiDockerfile = 'apps/api/Dockerfile',
    [string]$WebDockerfile = 'apps/web/Dockerfile',
    [string]$ApiImageRepository = 'caseguard-api',
    [string]$WebImageRepository = 'caseguard-web',
    [switch]$SkipImageBuild,
    [switch]$SkipMigration,
    [switch]$SkipSmokeTest,
    [switch]$GeneratePostgresPassword,
    [string]$ConfirmResourceGroupName = '',
    [ValidateRange(0, 600)][int]$RbacPropagationSeconds = 60
)

. (Join-Path $PSScriptRoot 'common.ps1')

$environmentName = 'dev'

function Invoke-CgDeployment {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$WithApps,
        [Parameter(Mandatory = $true)][string]$Tag
    )
    $env:CASEGUARD_DEPLOY_APPS = if ($WithApps) { 'true' } else { 'false' }
    $env:CASEGUARD_IMAGE_TAG = $Tag
    Write-Host ("Deploying '{0}' (apps: {1}) ..." -f $Name, $WithApps) -ForegroundColor Cyan
    & az deployment sub create `
        --subscription $script:subscription.Id `
        --location $Location `
        --name $Name `
        --parameters $script:paramFile `
        --only-show-errors `
        --output none
    if ($LASTEXITCODE -ne 0) {
        throw "Deployment '$Name' failed. Inspect it with: az deployment sub show --subscription $($script:subscription.Id) --name $Name  (see docs/runbooks/failed-deployment.md)"
    }
    $json = Invoke-CgAz -Arguments @('deployment', 'sub', 'show', '--subscription', $script:subscription.Id, '--name', $Name, '--query', 'properties.outputs', '--output', 'json')
    return ($json | ConvertFrom-Json)
}

function Get-CgStatusCode {
    param([Parameter(Mandatory = $true)][string]$Url, [int]$Attempts = 6, [int]$DelaySeconds = 10)
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { Write-Verbose 'TLS 1.2 selection not needed on this platform.' }
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60 -MaximumRedirection 5
            return [int]$response.StatusCode
        }
        catch {
            $status = $null
            if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $null -ne $_.Exception.Response) {
                $status = [int]$_.Exception.Response.StatusCode
            }
            # 401/403/404 are real answers; 5xx and connection errors can be a cold start, so retry those.
            if ($null -ne $status -and $status -lt 500) { return $status }
            if ($i -eq $Attempts) { return $(if ($null -ne $status) { $status } else { 0 }) }
            Write-Host ("  no usable answer yet (attempt {0}/{1}); waiting {2}s for a cold start ..." -f $i, $Attempts, $DelaySeconds)
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    return 0
}

$envBackup = @{
    CASEGUARD_DEPLOY_APPS             = $env:CASEGUARD_DEPLOY_APPS
    CASEGUARD_IMAGE_TAG               = $env:CASEGUARD_IMAGE_TAG
    CASEGUARD_POSTGRES_ADMIN_PASSWORD = $env:CASEGUARD_POSTGRES_ADMIN_PASSWORD
}

try {
    Assert-CgSubscriptionId -SubscriptionId $SubscriptionId

    $paths = Get-CgPaths
    $script:paramFile = Resolve-CgParameterFile -BicepDir $paths.BicepDir -Environment $environmentName -ParameterFile $ParameterFile
    Assert-CgNoPlaceholders -Path $script:paramFile

    Assert-CgAzureCli
    Assert-CgContainerAppsCli

    $script:subscription = Get-CgTargetSubscription -SubscriptionId $SubscriptionId
    $resourceGroup = Get-CgResourceGroupName -WorkloadName $WorkloadName -Environment $environmentName
    if (-not $ImageTag) { $ImageTag = Get-CgDefaultImageTag -RepoRoot $paths.RepoRoot }

    $needsPassword = -not (Test-CgParamFileSetting -Path $script:paramFile -Name 'postgresAuthMode' -Value 'entra')
    $details = @(
        "Parameter file  : $($script:paramFile)",
        "Image tag       : $ImageTag",
        'This creates billable resources. The dev database firewall opens to Azure-hosted clients unless you changed it.'
    )
    Show-CgTarget -Action 'DEPLOY (creates and updates Azure resources)' -Subscription $script:subscription -ResourceGroup $resourceGroup `
        -Environment $environmentName -Location $Location -Details $details
    Confirm-CgTarget -Prompt "Type the resource group name ($resourceGroup) to deploy" -ExpectedText $resourceGroup -Provided $ConfirmResourceGroupName

    if ($needsPassword) {
        if (-not [string]::IsNullOrEmpty($env:CASEGUARD_POSTGRES_ADMIN_PASSWORD)) {
            Write-Host 'Using the PostgreSQL password from CASEGUARD_POSTGRES_ADMIN_PASSWORD.'
        }
        elseif ($GeneratePostgresPassword) {
            $env:CASEGUARD_POSTGRES_ADMIN_PASSWORD = New-CgRandomPassword -Length 32
            Write-Host 'Generated a random PostgreSQL password. It is stored in Key Vault only and is not displayed.'
        }
        else {
            $secure = Read-Host 'PostgreSQL administrator password (16+ characters)' -AsSecureString
            $env:CASEGUARD_POSTGRES_ADMIN_PASSWORD = ConvertTo-CgPlainText -Secure $secure
        }
        if ($env:CASEGUARD_POSTGRES_ADMIN_PASSWORD.Length -lt 16) {
            throw 'The PostgreSQL administrator password must be at least 16 characters.'
        }
    }

    $stamp = Get-Date -Format 'yyyyMMddHHmmss'

    # Stage 1: everything except the apps and the job, because the registry is still empty.
    $stage1 = Invoke-CgDeployment -Name ("caseguard-dev-infra-$stamp") -WithApps $false -Tag $ImageTag
    $registry = $stage1.containerRegistryName.value

    if (-not $SkipImageBuild) {
        # Next.js bakes the /api rewrite target and NEXT_PUBLIC_* into the web image, so the web build needs values from
        # this environment. They are non-secret and come from the stage-1 deployment outputs.
        $webBuildArguments = @($stage1.webBuildArguments.value)
        foreach ($image in @(
                @{ Key = 'api'; Repository = $ApiImageRepository; Dockerfile = $ApiDockerfile },
                @{ Key = 'web'; Repository = $WebImageRepository; Dockerfile = $WebDockerfile })) {
            $dockerfilePath = Join-Path $paths.RepoRoot $image.Dockerfile
            if (-not (Test-Path -LiteralPath $dockerfilePath)) {
                throw "Dockerfile not found: $dockerfilePath. Pass -ApiDockerfile/-WebDockerfile (paths relative to the repository root)."
            }
            $buildArguments = @('--build-arg', "GIT_COMMIT=$ImageTag")
            if ($image.Key -eq 'web') {
                foreach ($pair in $webBuildArguments) { $buildArguments += @('--build-arg', "$pair") }
            }
            Write-Host ("Building {0}:{1} in registry {2} (az acr build) ..." -f $image.Repository, $ImageTag, $registry) -ForegroundColor Cyan
            & az acr build `
                --subscription $script:subscription.Id `
                --registry $registry `
                --image ("{0}:{1}" -f $image.Repository, $ImageTag) `
                --file $image.Dockerfile `
                @buildArguments `
                $paths.RepoRoot
            if ($LASTEXITCODE -ne 0) {
                throw "az acr build failed for $($image.Repository). If ACR Tasks is unavailable in your subscription, build locally with docker and push to $registry.azurecr.io, then re-run with -SkipImageBuild -ImageTag $ImageTag."
            }
        }
    }
    else {
        Write-Host ("Skipping the image build; the registry must already contain tag {0}." -f $ImageTag)
    }

    # Stage 2: the apps and the job. Role assignments from stage 1 need a moment to propagate.
    if ($RbacPropagationSeconds -gt 0) {
        Write-Host ("Waiting {0}s for role assignments to propagate ..." -f $RbacPropagationSeconds)
        Start-Sleep -Seconds $RbacPropagationSeconds
    }
    $stage2 = Invoke-CgDeployment -Name ("caseguard-dev-apps-$stamp") -WithApps $true -Tag $ImageTag
    $jobName = $stage2.migrateJobName.value
    $webUrl = $stage2.webUrl.value
    $apiApp = $stage2.apiAppName.value

    if (-not $SkipMigration) {
        Write-Host ("Starting the migration job {0} ..." -f $jobName) -ForegroundColor Cyan
        $execution = (Invoke-CgAz -Arguments @('containerapp', 'job', 'start', '--subscription', $script:subscription.Id, '--resource-group', $resourceGroup, '--name', $jobName, '--query', 'name', '--output', 'tsv')).Trim()
        $deadline = (Get-Date).AddMinutes(20)
        $status = ''
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 15
            $status = (Invoke-CgAz -Arguments @('containerapp', 'job', 'execution', 'show', '--subscription', $script:subscription.Id, '--resource-group', $resourceGroup, '--name', $jobName, '--job-execution-name', $execution, '--query', 'properties.status', '--output', 'tsv')).Trim()
            Write-Host ("  migration execution {0}: {1}" -f $execution, $status)
            if ($status -in @('Succeeded', 'Failed', 'Stopped', 'Degraded')) { break }
        }
        if ($status -ne 'Succeeded') {
            throw "The migration job ended with status '$status'. The API will not become ready. See docs/runbooks/broken-migration.md. Do not retry blindly."
        }
    }

    if (-not $SkipSmokeTest) {
        Write-Host ''
        Write-Host 'Smoke test (through the public web URL; the API is internal-only):' -ForegroundColor Cyan
        $rootStatus = Get-CgStatusCode -Url $webUrl
        $meStatus = Get-CgStatusCode -Url ("{0}/api/v1/me" -f $webUrl.TrimEnd('/'))
        Write-Host ("  GET /              -> {0} (expect 200-399)" -f $rootStatus)
        Write-Host ("  GET /api/v1/me     -> {0} (expect 401: the API answered through the web proxy and rejected the missing token)" -f $meStatus)
        Invoke-CgAz -Arguments @('containerapp', 'revision', 'list', '--subscription', $script:subscription.Id, '--resource-group', $resourceGroup, '--name', $apiApp, '--query', "[].{revision:name,active:properties.active,health:properties.healthState,running:properties.runningState}", '--output', 'table') | Write-Host
        if ($rootStatus -lt 200 -or $rootStatus -ge 400 -or $meStatus -ne 401) {
            throw 'Smoke test FAILED. Do not treat this deployment as working. See docs/DEPLOYMENT.md (post-deploy smoke tests) and docs/runbooks.'
        }
        Write-Host 'Smoke test passed.' -ForegroundColor Green
    }

    Write-Host ''
    Write-Host 'Deployment finished.' -ForegroundColor Green
    Write-Host ("Web URL         : {0}" -f $webUrl)
    Write-Host ("Resource group  : {0}" -f $resourceGroup)
    Write-Host ("Image tag       : {0}" -f $ImageTag)
    Write-Host 'Next: add the web URL as a SPA redirect URI in the Entra app registration (docs/ENTRA_ID_SETUP.md) before signing in.'
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
