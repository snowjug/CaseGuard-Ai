<#
.SYNOPSIS
  Shared helpers for the CaseGuard AI infrastructure scripts. Dot-source it: . "$PSScriptRoot\common.ps1"

.DESCRIPTION
  These helpers exist so that every script behaves the same way before it touches Azure:
    * strict mode and stop-on-error,
    * the TARGET (subscription id and name, tenant, resource group, environment, region) is printed first,
    * nothing runs without explicit confirmation,
    * a placeholder subscription id or a parameter file that still contains placeholders is refused,
    * the subscription is always passed explicitly (--subscription); the az "current subscription" is never relied
      upon and never changed.

  The scripts are HELPERS FOR A HUMAN OPERATOR. Nothing in this repository has run them against Azure. Read the
  script and docs/DEPLOYMENT.md before the first use. Compatible with Windows PowerShell 5.1 and PowerShell 7.
  The file is intentionally ASCII only so Windows PowerShell 5.1 parses it identically without a BOM.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CgPaths {
    <#
    .SYNOPSIS
      Returns the repository root and the infra directories, derived from the location of this file.
    #>
    $scriptsDir = $PSScriptRoot
    $infraDir = Split-Path -Parent $scriptsDir
    $repoRoot = Split-Path -Parent $infraDir
    return [pscustomobject]@{
        RepoRoot   = $repoRoot
        InfraDir   = $infraDir
        BicepDir   = Join-Path $infraDir 'bicep'
        ScriptsDir = $scriptsDir
    }
}

function Assert-CgAzureCli {
    <#
    .SYNOPSIS
      Fails with a clear message when the Azure CLI is not installed.
    #>
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'The Azure CLI (az) was not found on PATH. Install it from https://learn.microsoft.com/cli/azure/install-azure-cli and run az login.'
    }
}

function Test-CgPlaceholderGuid {
    <#
    .SYNOPSIS
      Returns $true when a value is not a plausible real GUID (malformed, all zeros, one repeated digit, or a well-known sample).
    #>
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
    $pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    if ($Value -notmatch $pattern) { return $true }
    $digits = ($Value -replace '-', '').ToLowerInvariant()
    if ($digits -match '^(.)\1{31}$') { return $true }
    if ($digits -eq '12345678123412341234123456789012') { return $true }
    return $false
}

function Assert-CgSubscriptionId {
    <#
    .SYNOPSIS
      Refuses a missing or placeholder-looking subscription id before any Azure call is made.
    #>
    param([string]$SubscriptionId)
    if (Test-CgPlaceholderGuid -Value $SubscriptionId) {
        throw "Refusing to continue: '$SubscriptionId' is missing or looks like a placeholder. Pass the real target subscription id with -SubscriptionId (or set CASEGUARD_SUBSCRIPTION_ID)."
    }
}

function Invoke-CgAz {
    <#
    .SYNOPSIS
      Runs the Azure CLI and returns its standard output as one string. Throws on a non-zero exit unless -AllowFailure.
    .DESCRIPTION
      stderr is not redirected (Windows PowerShell 5.1 turns redirected native stderr into terminating errors under
      $ErrorActionPreference Stop), so az warnings stay visible on the console.
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & az @Arguments
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        if ($AllowFailure) { return $null }
        $shown = ($Arguments | Select-Object -First 3) -join ' '
        throw "az $shown ... failed with exit code $code."
    }
    if ($null -eq $output) { return '' }
    return (($output | ForEach-Object { "$_" }) -join "`n")
}

function Get-CgTargetSubscription {
    <#
    .SYNOPSIS
      Looks up the explicitly requested subscription and returns id, name, tenant id and state.
    #>
    param([Parameter(Mandatory = $true)][string]$SubscriptionId)
    Assert-CgSubscriptionId -SubscriptionId $SubscriptionId
    $json = Invoke-CgAz -Arguments @('account', 'show', '--subscription', $SubscriptionId, '--output', 'json') -AllowFailure
    if (-not $json) {
        throw "Subscription '$SubscriptionId' is not available to the signed-in az account. Run az login with an account that can see it. Nothing was changed."
    }
    $account = $json | ConvertFrom-Json
    if ($account.id -ne $SubscriptionId) {
        throw "az returned subscription '$($account.id)' for the requested '$SubscriptionId'. Refusing to continue."
    }
    if ($account.state -ne 'Enabled') {
        throw "Subscription '$($account.name)' is in state '$($account.state)', not Enabled. Refusing to continue."
    }
    return [pscustomobject]@{
        Id       = $account.id
        Name     = $account.name
        TenantId = $account.tenantId
        State    = $account.state
    }
}

function Show-CgTarget {
    <#
    .SYNOPSIS
      Prints the target of the operation. Call it before anything that changes Azure and before asking for confirmation.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [Parameter(Mandatory = $true)]$Subscription,
        [Parameter(Mandatory = $true)][string]$ResourceGroup,
        [Parameter(Mandatory = $true)][string]$Environment,
        [string]$Location = '',
        [string[]]$Details = @()
    )
    Write-Host ''
    Write-Host '==================== TARGET ====================' -ForegroundColor Yellow
    Write-Host ("Action          : {0}" -f $Action)
    Write-Host ("Subscription    : {0}" -f $Subscription.Name)
    Write-Host ("Subscription id : {0}" -f $Subscription.Id)
    Write-Host ("Tenant id       : {0}" -f $Subscription.TenantId)
    Write-Host ("Resource group  : {0}" -f $ResourceGroup)
    Write-Host ("Environment     : {0}" -f $Environment)
    if ($Location) { Write-Host ("Region          : {0}" -f $Location) }
    foreach ($line in $Details) { Write-Host $line }
    Write-Host '================================================' -ForegroundColor Yellow
    Write-Host ''
}

function Confirm-CgTarget {
    <#
    .SYNOPSIS
      Requires the operator to type an exact phrase. Throws (nothing happens) when the phrase does not match.
    .PARAMETER ExpectedText
      The exact, case-sensitive text that must be typed.
    .PARAMETER Provided
      A pre-supplied answer for automation (for example -ConfirmResourceGroupName). It must still match exactly.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][string]$ExpectedText,
        [string]$Provided = ''
    )
    $answer = $Provided
    if ([string]::IsNullOrEmpty($answer)) {
        if (-not [Environment]::UserInteractive) {
            throw 'Confirmation is required but this session is not interactive. Supply the confirmation text through the matching parameter.'
        }
        $answer = Read-Host $Prompt
    }
    if (-not ($answer -ceq $ExpectedText)) {
        throw 'Confirmation text did not match. Nothing was changed.'
    }
}

function Get-CgPlaceholderLines {
    <#
    .SYNOPSIS
      Returns the non-comment lines of a Bicep parameter file that still contain template placeholders.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "Parameter file not found: $Path" }
    $patterns = @(
        '00000000-0000-0000-0000-000000000000',
        '@example\.com',
        'CHANGE-ME',
        '<[A-Za-z][A-Za-z0-9 _-]*>'
    )
    $found = @()
    $lineNumber = 0
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $lineNumber++
        $code = $line.Trim()
        if ($code.StartsWith('//')) { continue }
        $code = ($code -replace '\s//\s.*$', '')
        foreach ($pattern in $patterns) {
            if ($code -match $pattern) {
                $found += ("{0}: {1}" -f $lineNumber, $line.Trim())
                break
            }
        }
    }
    return , $found
}

function Assert-CgNoPlaceholders {
    <#
    .SYNOPSIS
      Refuses to continue while the parameter file still contains placeholder values.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    $lines = Get-CgPlaceholderLines -Path $Path
    if ($lines.Count -gt 0) {
        $list = ($lines | ForEach-Object { "  line $_" }) -join "`n"
        throw ("The parameter file still contains placeholder values:`n$list`nCopy it to a *.local.bicepparam file (git-ignored), put real values there and pass it with -ParameterFile.")
    }
}

function Resolve-CgParameterFile {
    <#
    .SYNOPSIS
      Picks the parameter file: the explicit one, else main.<env>.local.bicepparam, else the committed dev template.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$BicepDir,
        [Parameter(Mandatory = $true)][string]$Environment,
        [string]$ParameterFile = ''
    )
    if ($ParameterFile) {
        if (-not (Test-Path -LiteralPath $ParameterFile)) { throw "Parameter file not found: $ParameterFile" }
        return (Resolve-Path -LiteralPath $ParameterFile).Path
    }
    $local = Join-Path $BicepDir ("main.{0}.local.bicepparam" -f $Environment)
    if (Test-Path -LiteralPath $local) { return $local }
    $template = Join-Path $BicepDir ("main.{0}.bicepparam" -f $Environment)
    if (Test-Path -LiteralPath $template) { return $template }
    throw "No parameter file found for environment '$Environment'. Copy the matching *.bicepparam.template to main.$Environment.local.bicepparam and fill it in."
}

function ConvertFrom-CgJsonArray {
    <#
    .SYNOPSIS
      Parses a JSON document that should be a list and always returns an array (empty for null or blank input).
    #>
    param([string]$Json)
    if ([string]::IsNullOrWhiteSpace($Json)) { return , @() }
    $parsed = ConvertFrom-Json -InputObject $Json
    if ($null -eq $parsed) { return , @() }
    return , @($parsed)
}

function ConvertTo-CgPlainText {
    <#
    .SYNOPSIS
      Converts a SecureString to plain text for the short time it is handed to a child process through the environment.
    #>
    param([Parameter(Mandatory = $true)][System.Security.SecureString]$Secure)
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function New-CgRandomPassword {
    <#
    .SYNOPSIS
      Generates a random password (letters, digits, - and _) with at least one upper case letter, lower case letter and digit.
    #>
    param([int]$Length = 32)
    if ($Length -lt 16) { throw 'Password length must be at least 16.' }
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    $lower = 'abcdefghijkmnopqrstuvwxyz'
    $digits = '23456789'
    $all = $upper + $lower + $digits + '-_'
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        function Get-CgRandomChar([string]$Alphabet, $Generator) {
            $buffer = New-Object 'byte[]' 4
            $limit = [uint32]::MaxValue - ([uint32]::MaxValue % [uint32]$Alphabet.Length)
            do {
                $Generator.GetBytes($buffer)
                $value = [BitConverter]::ToUInt32($buffer, 0)
            } while ($value -ge $limit)
            return $Alphabet[[int]($value % [uint32]$Alphabet.Length)]
        }
        $chars = New-Object System.Collections.Generic.List[char]
        $chars.Add((Get-CgRandomChar $upper $rng))
        $chars.Add((Get-CgRandomChar $lower $rng))
        $chars.Add((Get-CgRandomChar $digits $rng))
        while ($chars.Count -lt $Length) { $chars.Add((Get-CgRandomChar $all $rng)) }
        # Fisher-Yates shuffle so the guaranteed characters are not always first.
        for ($i = $chars.Count - 1; $i -gt 0; $i--) {
            $buffer = New-Object 'byte[]' 4
            $rng.GetBytes($buffer)
            $j = [int]([BitConverter]::ToUInt32($buffer, 0) % [uint32]($i + 1))
            $swap = $chars[$i]; $chars[$i] = $chars[$j]; $chars[$j] = $swap
        }
        return (-join $chars)
    }
    finally {
        $rng.Dispose()
    }
}

function Get-CgResourceGroupName {
    <#
    .SYNOPSIS
      Resource group name used by main.bicep: rg-<workload>-<env> (the environment is dev, stg or prd in names).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$WorkloadName,
        [Parameter(Mandatory = $true)][ValidateSet('dev', 'staging', 'prod')][string]$Environment
    )
    $short = @{ dev = 'dev'; staging = 'stg'; prod = 'prd' }[$Environment]
    return ('rg-{0}-{1}' -f $WorkloadName, $short)
}

function Assert-CgContainerAppsCli {
    <#
    .SYNOPSIS
      Fails with an install hint when the az containerapp command group is not available.
    #>
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & az containerapp --help *> $null
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        throw 'The az containerapp commands are not available. Run: az extension add --name containerapp --upgrade'
    }
}

function Get-CgDefaultImageTag {
    <#
    .SYNOPSIS
      Builds an immutable image tag: the short git commit, with a timestamp suffix when the working tree is dirty.
      Falls back to a timestamp outside a git repository.
    #>
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $stamp }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $sha = & git -C $RepoRoot rev-parse --short=12 HEAD 2> $null
        $code = $LASTEXITCODE
        $dirty = & git -C $RepoRoot status --porcelain 2> $null
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0 -or [string]::IsNullOrWhiteSpace("$sha")) { return $stamp }
    if ($dirty) { return ("{0}-dirty{1}" -f $sha, $stamp) }
    return "$sha"
}

function Test-CgParamFileSetting {
    <#
    .SYNOPSIS
      Returns $true when a parameter file assigns the given literal value to the given parameter (comments ignored).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $code = ($line.Trim() -replace '\s//\s.*$', '')
        if ($code.StartsWith('//')) { continue }
        if ($code -match ("^param\s+{0}\s*=\s*'{1}'\s*$" -f [regex]::Escape($Name), [regex]::Escape($Value))) { return $true }
    }
    return $false
}
