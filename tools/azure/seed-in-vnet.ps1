[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string] $ResourceGroup,
  [Parameter(Mandatory)] [ValidatePattern('^[a-z0-9]{3,44}$')] [string] $AccountName,
  [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string] $SubnetId,
  [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string] $SeedIdentityName,
  [Parameter(Mandatory)] [ValidatePattern('^[0-9a-fA-F]{40}$')] [string] $SourceCommit,
  [ValidateRange(1, 60)] [int] $WaitTimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'
$SourceCommit = $SourceCommit.ToLowerInvariant()
$SourceUrl = "https://github.com/jaydestro/cosmos-agentic-support-api/archive/$SourceCommit.tar.gz"
$NodeImage = 'node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8'
$ContainerName = "resolve-seed-$([Guid]::NewGuid().ToString('N'))"
$RunId = [Guid]::NewGuid().ToString('N')
$ContainerCreated = $false
$RunnerExitCode = $null

function Invoke-Az {
  param([Parameter(Mandatory)] [string[]] $Arguments)

  $output = & az @Arguments
  $nativeExitCode = $LASTEXITCODE
  if ($nativeExitCode -ne 0) {
    throw "Azure CLI command failed with exit code $nativeExitCode."
  }
  return ($output -join [Environment]::NewLine)
}

$resourceGroupInfo = (Invoke-Az -Arguments @('group', 'show', '--name', $ResourceGroup, '--output', 'json')) | ConvertFrom-Json
$resourceGroupId = ([string]$resourceGroupInfo.id).TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($resourceGroupId) -or $resourceGroupInfo.name -cne $ResourceGroup) {
  throw 'The resource group could not be validated.'
}

$account = (Invoke-Az -Arguments @(
  'cosmosdb', 'show', '--resource-group', $ResourceGroup, '--name', $AccountName,
  '--query', '{id:id,name:name,capabilities:capabilities,locations:locations,publicNetworkAccess:publicNetworkAccess,disableLocalAuth:disableLocalAuth}',
  '--output', 'json'
)) | ConvertFrom-Json
$accountId = "$resourceGroupId/providers/Microsoft.DocumentDB/databaseAccounts/$AccountName"
$accountCapabilities = @($account.capabilities | ForEach-Object { [string]$_.name })
if (
  $account.name -cne $AccountName -or
  ([string]$account.id).TrimEnd('/') -ine $accountId -or
  'EnableServerless' -notin $accountCapabilities -or
  @($account.locations).Count -ne 1 -or
  $account.publicNetworkAccess -cne 'Disabled' -or
  $account.disableLocalAuth -ne $true
) {
  throw 'The Cosmos DB account is not the expected private, single-region serverless account.'
}

$identity = (Invoke-Az -Arguments @(
  'identity', 'show', '--resource-group', $ResourceGroup, '--name', $SeedIdentityName,
  '--query', '{id:id,clientId:clientId,principalId:principalId,name:name}',
  '--output', 'json'
)) | ConvertFrom-Json
if (
  $identity.name -cne $SeedIdentityName -or
  -not ([string]$identity.id).StartsWith("$resourceGroupId/providers/Microsoft.ManagedIdentity/userAssignedIdentities/", [StringComparison]::OrdinalIgnoreCase) -or
  [string]::IsNullOrWhiteSpace([string]$identity.clientId) -or
  [string]::IsNullOrWhiteSpace([string]$identity.principalId)
) {
  throw 'The dedicated seed identity could not be validated in the target resource group.'
}

$subnetPattern = '^/subscriptions/[^/]+/resourceGroups/([^/]+)/providers/Microsoft\.Network/virtualNetworks/([^/]+)/subnets/([^/]+)$'
if ($SubnetId -notmatch $subnetPattern) {
  throw 'SubnetId must be the full resource ID of a subnet.'
}
$subnetResourceGroup = $Matches[1]
$vnetName = $Matches[2]
$subnetName = $Matches[3]
if ($subnetResourceGroup -ine $ResourceGroup) {
  throw 'The seed subnet must be in the specified resource group.'
}

$subnet = (Invoke-Az -Arguments @(
  'network', 'vnet', 'subnet', 'show', '--ids', $SubnetId,
  '--query', '{id:id,delegations:delegations}',
  '--output', 'json'
)) | ConvertFrom-Json
$subnetDelegations = @($subnet.delegations | ForEach-Object { [string]$_.serviceName })
if (
  ([string]$subnet.id).TrimEnd('/') -ine $SubnetId.TrimEnd('/') -or
  'Microsoft.ContainerInstance/containerGroups' -notin $subnetDelegations
) {
  throw 'The specified subnet is not delegated to Azure Container Instances.'
}

$runnerCommand = @'
set -eu
mkdir -p /tmp/resolve-seed
timeout --kill-after=15s 3m node --input-type=module -e 'import {createWriteStream} from "node:fs"; import {Readable} from "node:stream"; import {pipeline} from "node:stream/promises"; const response = await fetch(process.env.SOURCE_URL, {signal: AbortSignal.timeout(120000)}); if (!response.ok || response.body === null) throw new Error(`archive download failed (${response.status})`); await pipeline(Readable.fromWeb(response.body), createWriteStream("/tmp/resolve-source.tar.gz", {flags: "wx"}));'
timeout --kill-after=15s 5m tar -xzf /tmp/resolve-source.tar.gz -C /tmp/resolve-seed --strip-components=1
cd /tmp/resolve-seed
timeout --kill-after=15s 10m npm ci --omit=dev --ignore-scripts --no-audit --no-fund --fetch-retries=2 --fetch-timeout=120000
echo "## Seed run 1"
timeout --kill-after=15s 10m node tools/seed/main.ts --target cloud --confirm-account "$COSMOS_ACCOUNT_NAME"
echo "## Seed run 2 (repeat, must not overwrite)"
timeout --kill-after=15s 10m node tools/seed/main.ts --target cloud --confirm-account "$COSMOS_ACCOUNT_NAME"
'@
$encodedRunnerCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($runnerCommand))
$containerCommand = "sh -c 'printf %s $encodedRunnerCommand | base64 -d | sh'"

$timer = [Diagnostics.Stopwatch]::StartNew()
try {
  $null = Invoke-Az -Arguments @(
    'container', 'create',
    '--resource-group', $ResourceGroup,
    '--name', $ContainerName,
    '--image', $NodeImage,
    '--os-type', 'Linux',
    '--cpu', '1',
    '--memory', '1.5',
    '--restart-policy', 'Never',
    '--vnet', $vnetName,
    '--subnet', $subnetName,
    '--assign-identity', [string]$identity.id,
    '--tags', 'managedBy=seed-in-vnet.ps1', "runId=$RunId", "sourceCommit=$SourceCommit",
    '--environment-variables',
    "COSMOS_ACCOUNT_NAME=$AccountName",
    "COSMOS_ENDPOINT=https://$AccountName.documents.azure.com:443/",
    'COSMOS_DATABASE=resolve',
    'COSMOS_AUTH=managed-identity',
    "SEED_CLIENT_ID=$($identity.clientId)",
    "SEED_PRINCIPAL_ID=$($identity.principalId)",
    "SOURCE_URL=$SourceUrl",
    '--command-line', $containerCommand,
    '--output', 'none'
  )
  $ContainerCreated = $true

  $attachedIdentityJson = Invoke-Az -Arguments @(
    'container', 'show', '--resource-group', $ResourceGroup, '--name', $ContainerName,
    '--query', 'identity', '--output', 'json'
  )
  $attachedIdentityMap = $attachedIdentityJson | ConvertFrom-Json
  $attachedIdentityIds = @($attachedIdentityMap.userAssignedIdentities.PSObject.Properties | ForEach-Object { $_.Name })
  if (
    $attachedIdentityMap.type -cne 'UserAssigned' -or
    $attachedIdentityIds.Count -ne 1 -or
    $attachedIdentityIds[0] -ine [string]$identity.id
  ) {
    throw 'The runner does not have exactly the dedicated seed identity attached.'
  }

  $terminalState = $null
  while ($timer.Elapsed.TotalSeconds -lt ($WaitTimeoutMinutes * 60)) {
    $currentStateJson = Invoke-Az -Arguments @(
      'container', 'show', '--resource-group', $ResourceGroup, '--name', $ContainerName,
      '--query', 'containers[0].instanceView.currentState', '--output', 'json'
    )
    $currentState = $currentStateJson | ConvertFrom-Json
    if ($null -ne $currentState -and [string]$currentState.state -notin @('', 'Waiting', 'Running')) {
      $terminalState = $currentState
      break
    }

    $remainingSeconds = ($WaitTimeoutMinutes * 60) - $timer.Elapsed.TotalSeconds
    if ($remainingSeconds -gt 0) {
      Start-Sleep -Seconds ([int][Math]::Min(15, [Math]::Ceiling($remainingSeconds)))
    }
  }

  if ($null -eq $terminalState) {
    throw "The seed container exceeded the $WaitTimeoutMinutes minute wait limit."
  }
  if ($terminalState.state -cne 'Terminated' -or $null -eq $terminalState.exitCode) {
    throw "The seed container stopped in unexpected state '$($terminalState.state)'."
  }

  $logs = Invoke-Az -Arguments @('container', 'logs', '--resource-group', $ResourceGroup, '--name', $ContainerName)
  if (-not [string]::IsNullOrWhiteSpace($logs)) {
    Write-Output $logs
  }
  $RunnerExitCode = [int]$terminalState.exitCode
} finally {
  if ($ContainerCreated) {
    $cleanupTagsJson = Invoke-Az -Arguments @(
      'container', 'show', '--resource-group', $ResourceGroup, '--name', $ContainerName,
      '--query', 'tags', '--output', 'json'
    )
    $cleanupTags = $cleanupTagsJson | ConvertFrom-Json
    if ($cleanupTags.managedBy -cne 'seed-in-vnet.ps1' -or $cleanupTags.runId -cne $RunId) {
      throw 'Refusing to delete a container group not owned by this invocation.'
    }
    $null = Invoke-Az -Arguments @('container', 'delete', '--resource-group', $ResourceGroup, '--name', $ContainerName, '--yes', '--output', 'none')
  }
}

if ($null -ne $RunnerExitCode -and $RunnerExitCode -ne 0) {
  [Console]::Error.WriteLine("The seed container exited with code $RunnerExitCode.")
  exit $RunnerExitCode
}
