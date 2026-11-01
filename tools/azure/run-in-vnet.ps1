# Runs the seed and proof driver in a short-lived container inside the virtual network.
# Prerequisites: `npm run build; npm run package`, an `az login` with Contributor on the resource group,
# and the deployment from infra/main.bicep. The runner receives the application and seed managed identities.
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $EntraTenantId,
  [Parameter(Mandatory)] [string] $ApiAudience,
  [string] $LogFile = '.local/azure-proof-runner.log',
  [switch] $ProbeOnly
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot/../.."
$suffix = (az deployment group show -g $ResourceGroup -n resolve-proof-api --query "properties.outputs.functionName.value" -o tsv).Split('-')[1]
$storage = "st$suffix"
$key = az storage account keys list -g $ResourceGroup -n $storage --query "[0].value" -o tsv
$app = az identity show -g $ResourceGroup -n "resolve-app-$suffix" --query "{id:id,c:clientId}" -o json | ConvertFrom-Json
$seed = az identity show -g $ResourceGroup -n "resolve-seed-$suffix" --query "{id:id,c:clientId,p:principalId}" -o json | ConvertFrom-Json

$stage = Join-Path $root '.local/runner'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Copy-Item (Join-Path $root '.artifacts/package/*') $stage -Recurse
Copy-Item (Join-Path $root 'src'), (Join-Path $root 'tools') -Destination $stage -Recurse
tar -czf (Join-Path $root '.local/runner.tgz') -C $stage .
az storage share-rm create -g $ResourceGroup --storage-account $storage -n runner --quota 1 -o none
az storage file upload --account-name $storage --account-key $key --share-name runner --source (Join-Path $root '.local/runner.tgz') --path runner.tgz -o none
az storage file upload --account-name $storage --account-key $key --share-name runner --source (Join-Path $PSScriptRoot 'run.sh') --path run.sh -o none

az container delete -g $ResourceGroup -n resolve-proof-runner --yes -o none 2>$null
az container create -g $ResourceGroup -n resolve-proof-runner --image node:24-slim --os-type Linux --cpu 1 --memory 1.5 `
  --restart-policy Never --vnet "resolve-vnet-$suffix" --subnet seed-runner --assign-identity $app.id $seed.id `
  --azure-file-volume-account-name $storage --azure-file-volume-account-key $key --azure-file-volume-share-name runner --azure-file-volume-mount-path /mnt/runner `
  --environment-variables RESOLVE_ENV=azure COSMOS_ACCOUNT_NAME="resolve-$suffix" COSMOS_ENDPOINT="https://resolve-$suffix.documents.azure.com:443/" `
  COSMOS_AUTH=managed-identity AZURE_CLIENT_ID=$($app.c) AUTH_MODE=entra ENTRA_TENANT_ID=$EntraTenantId ENTRA_AUDIENCE=$ApiAudience `
  SEED_CLIENT_ID=$($seed.c) SEED_PRINCIPAL_ID=$($seed.p) PROBE_ONLY=$(if ($ProbeOnly) { '1' } else { '0' }) --command-line "sh /mnt/runner/run.sh" -o none

do {
  Start-Sleep 20
  $state = az container show -g $ResourceGroup -n resolve-proof-runner --query "containers[0].instanceView.currentState.state" -o tsv
} while ($state -in 'Running', 'Waiting', $null, '')
az container logs -g $ResourceGroup -n resolve-proof-runner | Set-Content (Join-Path $root $LogFile)
$exit = az container show -g $ResourceGroup -n resolve-proof-runner --query "containers[0].instanceView.currentState.exitCode" -o tsv
Write-Host "runner finished: state=$state exit=$exit log=$LogFile"
exit ([int]$exit)
