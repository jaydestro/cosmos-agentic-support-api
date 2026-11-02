[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string] $ResourceGroup,
  [Parameter(Mandatory)] [ValidatePattern('^[a-z0-9][a-z0-9-]{1,42}[a-z0-9]$')] [string] $AccountName,
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
$CreateAttempted = $false
$CreateAcknowledged = $false
$RunnerExitCode = $null
$deadline = [DateTime]::UtcNow.AddMinutes($WaitTimeoutMinutes)

function Invoke-Az {
  param(
    [Parameter(Mandatory)] [string[]] $Arguments,
    [switch] $AllowNotFound
  )

  $remainingMilliseconds = [Math]::Min(60000, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if ($remainingMilliseconds -le 0) {
    throw "The seed runner exceeded the $WaitTimeoutMinutes minute wait limit."
  }
  $azPath = (Get-Command az -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $startInfo = [Diagnostics.ProcessStartInfo]::new($azPath)
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit([int]$remainingMilliseconds)) {
      $process.Kill($true)
      $null = $process.WaitForExit(1000)
      throw "Azure CLI $($Arguments[0..1] -join ' ') exceeded its process deadline."
    }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 1000)) {
      throw 'Azure CLI output did not close within its process deadline.'
    }
    if ($process.ExitCode -ne 0) {
      if ($AllowNotFound -and $stderr.Result -match '(?m)^ERROR: \((ResourceNotFound|ContainerGroupNotFound)\)') {
        return $null
      }
      throw "Azure CLI $($Arguments[0..1] -join ' ') failed with exit code $($process.ExitCode): $($stderr.Result.Trim())"
    }
    return $stdout.Result
  } finally {
    $process.Dispose()
  }
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
  '--query', '{id:id,clientId:clientId,principalId:principalId,name:name,tags:tags}',
  '--output', 'json'
)) | ConvertFrom-Json
if ($AccountName -notmatch '^(?<prefix>[a-z0-9-]{3,12})-(?<suffix>[a-z0-9]{13})$') {
  throw 'The account name must match the generated Resolve deployment namespace.'
}
$deploymentPrefix = $Matches.prefix
$expectedIdentityName = "$deploymentPrefix-seed-$($Matches.suffix)"
if (
  $SeedIdentityName -cne $expectedIdentityName -or
  $identity.name -cne $SeedIdentityName -or
  ([string]$identity.id).TrimEnd('/') -ine "$resourceGroupId/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$expectedIdentityName" -or
  $identity.tags.project -cne 'resolve' -or
  $identity.tags.purpose -cne 'reference-seeding' -or
  [string]::IsNullOrWhiteSpace([string]$identity.clientId) -or
  [string]::IsNullOrWhiteSpace([string]$identity.principalId)
) {
  throw 'The dedicated seed identity could not be validated in the target resource group.'
}

$subnetPattern = "^$([Regex]::Escape($resourceGroupId))/providers/Microsoft\.Network/virtualNetworks/[^/]+/subnets/[^/]+$"
if ($SubnetId -notmatch $subnetPattern) {
  throw 'SubnetId must be a full subnet resource ID in the validated resource group and subscription.'
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

$assignments = @(Invoke-Az -Arguments @(
  'cosmosdb', 'sql', 'role', 'assignment', 'list', '--resource-group', $ResourceGroup,
  '--account-name', $AccountName, '--output', 'json'
) | ConvertFrom-Json | Where-Object { $_.principalId -ieq $identity.principalId })
$definitions = @(Invoke-Az -Arguments @(
  'cosmosdb', 'sql', 'role', 'definition', 'list', '--resource-group', $ResourceGroup,
  '--account-name', $AccountName, '--output', 'json'
) | ConvertFrom-Json)
$itemAction = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items'
$expectedActions = @(
  'Microsoft.DocumentDB/databaseAccounts/readMetadata',
  'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery',
  'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/readChangeFeed',
  "$itemAction/read", "$itemAction/create"
)
if ($assignments.Count -eq 0) {
  throw 'The reference-seeder native Cosmos role grant is missing; role bootstrap remains blocked on #10.'
}
foreach ($assignment in $assignments) {
  $definition = @($definitions | Where-Object { $_.id -ieq $assignment.roleDefinitionId })
  if (
    $assignment.scope -ine "$accountId/dbs/resolve/colls/reference" -or
    $definition.Count -ne 1 -or
    $definition[0].roleName -cne "$deploymentPrefix-reference-seeder" -or
    $definition[0].type -cne 'CustomRole' -or
    @($definition[0].assignableScopes).Count -ne 1 -or
    $definition[0].assignableScopes[0] -ine $accountId -or
    @($definition[0].permissions).Count -ne 1 -or
    @($definition[0].permissions[0].notDataActions | Where-Object { $null -ne $_ }).Count -gt 0 -or
    @(Compare-Object $expectedActions @($definition[0].permissions[0].dataActions)).Count -ne 0
  ) {
    throw 'The seed identity must have only the deployment reference-seeder native Cosmos permissions at reference-container scope.'
  }
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

$originalError = $null
try {
  $CreateAttempted = $true
  $null = Invoke-Az -Arguments @(
    'container', 'create',
    '--resource-group', $ResourceGroup,
    '--name', $ContainerName,
    '--image', $NodeImage,
    '--os-type', 'Linux',
    '--cpu', '1',
    '--memory', '1.5',
    '--restart-policy', 'Never',
    '--subnet', $SubnetId,
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
    '--no-wait', '--output', 'none'
  )
  $CreateAcknowledged = $true

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
  while ([DateTime]::UtcNow -lt $deadline) {
    $currentStateJson = Invoke-Az -Arguments @(
      'container', 'show', '--resource-group', $ResourceGroup, '--name', $ContainerName,
      '--query', 'containers[0].instanceView.currentState', '--output', 'json'
    )
    $currentState = $currentStateJson | ConvertFrom-Json
    if ($null -ne $currentState -and [string]$currentState.state -notin @('', 'Waiting', 'Running')) {
      $terminalState = $currentState
      break
    }

    $remainingSeconds = ($deadline - [DateTime]::UtcNow).TotalSeconds
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

  $RunnerExitCode = [int]$terminalState.exitCode
  if ($RunnerExitCode -ne 0) {
    $originalError = "The seed container exited with code $RunnerExitCode."
  }
  try {
    $logs = Invoke-Az -Arguments @('container', 'logs', '--resource-group', $ResourceGroup, '--name', $ContainerName)
    if (-not [string]::IsNullOrWhiteSpace($logs)) {
      Write-Output $logs
    }
  } catch {
    if ($RunnerExitCode -eq 0) { throw }
    [Console]::Error.WriteLine("Seed log retrieval failed: $($_.Exception.Message)")
  }
} catch {
  $originalError = $_
  throw
} finally {
  if ($CreateAttempted) {
    # Cleanup has its own bounded allowance even when the execution deadline has expired.
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    try {
      for ($attempt = 1; $attempt -le 3; $attempt++) {
        $cleanupTagsJson = Invoke-Az -AllowNotFound -Arguments @(
          'container', 'show', '--resource-group', $ResourceGroup, '--name', $ContainerName,
          '--query', 'tags', '--output', 'json'
        )
        if ($null -ne $cleanupTagsJson -or $CreateAcknowledged) { break }
        if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
      }
      if ($null -eq $cleanupTagsJson -and -not $CreateAcknowledged) {
        throw 'Create was not acknowledged and the container is still not visible after reconciliation; inspect this exact name for delayed creation.'
      }
      if ($null -ne $cleanupTagsJson) {
        $cleanupTags = $cleanupTagsJson | ConvertFrom-Json
        if ($cleanupTags.managedBy -cne 'seed-in-vnet.ps1' -or $cleanupTags.runId -cne $RunId -or $cleanupTags.sourceCommit -cne $SourceCommit) {
          throw 'Refusing to delete a container group not owned by this invocation.'
        }
        $null = Invoke-Az -Arguments @('container', 'delete', '--resource-group', $ResourceGroup, '--name', $ContainerName, '--yes', '--output', 'none')
      }
    } catch {
      $cleanupMessage = "Cleanup failed for '$ResourceGroup/$ContainerName': $($_.Exception.Message)"
      if ($null -ne $originalError) {
        [Console]::Error.WriteLine($cleanupMessage)
      } else {
        throw $cleanupMessage
      }
    }
  }
}

if ($null -ne $RunnerExitCode -and $RunnerExitCode -ne 0) {
  [Console]::Error.WriteLine("The seed container exited with code $RunnerExitCode.")
  exit $RunnerExitCode
}
