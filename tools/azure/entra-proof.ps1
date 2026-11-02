# Real-token proof against the deployed API. Needs `az login` as a user who can assign app roles on the API's enterprise
# application. The API app must also carry the extra identifier URIs api://resolve-proof-a, -b and -c.
#
# The Azure CLI caches tokens by scope string, so a token keeps the app roles it had when it was first issued. Each phase
# therefore asks for its token through a different scope string for the same API (same audience, same claims format).
# The script changes the signed-in user's app roles between phases and restores the original set at the end.
# Output is Markdown on stdout.
param(
  [Parameter(Mandatory)] [string] $ApiUrl,
  [Parameter(Mandatory)] [string] $ApiAppId,
  [Parameter(Mandatory)] [string] $ApiServicePrincipalId,
  [string] $ApproveCaseId = ''
)
$ErrorActionPreference = 'Stop'
$h = 'Content-Type=application/json'
$me = az ad signed-in-user show --query id -o tsv
$tmp = Join-Path $env:TEMP 'resolve-roles'; New-Item -ItemType Directory -Force $tmp | Out-Null
$roles = az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/$ApiServicePrincipalId" --query "appRoles[].{id:id,v:value}" -o json | ConvertFrom-Json
function RoleId($value) { ($roles | Where-Object v -eq $value).id }
function Assigned() {
  $all = (az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/$ApiServicePrincipalId/appRoleAssignedTo" -o json | ConvertFrom-Json).value
  @($all | Where-Object { $_.principalId -eq $me })
}
function SetRoles([string[]] $values) {
  foreach ($a in (Assigned)) { az rest --method delete --url "https://graph.microsoft.com/v1.0/servicePrincipals/$ApiServicePrincipalId/appRoleAssignedTo/$($a.id)" -o none }
  foreach ($value in $values) {
    $file = Join-Path $tmp "$value.json"
    [IO.File]::WriteAllText($file, (@{ principalId = $me; resourceId = $ApiServicePrincipalId; appRoleId = (RoleId $value) } | ConvertTo-Json -Compress))
    az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$ApiServicePrincipalId/appRoleAssignedTo" --headers $h --body "@$file" -o none
  }
  Start-Sleep 20
}
function Token([string] $scope) {
  $tok = az account get-access-token --scope $scope --query accessToken -o tsv
  $payload = $tok.Split('.')[1].Replace('-', '+').Replace('_', '/'); while ($payload.Length % 4) { $payload += '=' }
  $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
  [pscustomobject]@{ Token = $tok; Roles = ($claims.roles -join ', '); Scope = $claims.scp }
}
function Call($method, $path, $token, $body = $null, $headers = @{}) {
  $h2 = @{ Authorization = "Bearer $token" } + $headers
  $a = @{ Uri = "$ApiUrl$path"; Method = $method; Headers = $h2; SkipHttpErrorCheck = $true }
  if ($null -ne $body) { $a.Body = ($body | ConvertTo-Json -Depth 6); $a.ContentType = 'application/json' }
  $r = Invoke-WebRequest @a
  $text = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
  $code = ''; try { $code = ($text | ConvertFrom-Json).code } catch { }
  [pscustomobject]@{ Status = [int]$r.StatusCode; Code = $code; Body = $text }
}
function Line($label, $r) { $suffix = ''; if ($r.Code) { $suffix = ' `' + $r.Code + '`' }; "- ${label} : HTTP $($r.Status)$suffix" }
function Json($r) { $r.Body | ConvertFrom-Json }
function AwaitStatus($caseId, $token, $wanted) {
  for ($i = 0; $i -lt 60; $i++) { $c = Json (Call GET "/api/cases/$caseId" $token); if ($c.status -eq $wanted) { return $c.status }; Start-Sleep 3 }
  $c.status
}

$original = @(Assigned | ForEach-Object { $rid = $_.appRoleId; ($roles | Where-Object id -eq $rid).v })
$case = @{ accountId = 'acct_aurora_0001'; invoiceIds = @('inv_aurora_0001_a', 'inv_aurora_0001_b'); category = 'duplicate_charge'; requestedCredit = @{ amountMinor = 4900; currency = 'USD' }; description = 'The same invoice appears to have been charged twice this month.' }
try {
  '# Real Entra token proof against the deployed API'
  ''
  'Tokens are real delegated v2 tokens issued by Microsoft Entra ID for the Resolve API app (scope access_as_user).'
  ''
  SetRoles 'Resolve.Representative.aurora'
  $t = Token 'api://resolve-proof-c/access_as_user'
  "## 1. Representative (aurora) only. Token roles: $($t.Roles); scope: $($t.Scope)"
  Line 'GET /api/session' (Call GET '/api/session' $t.Token)
  Line 'POST /api/cases without an Idempotency-Key (rejected before any write)' (Call POST '/api/cases' $t.Token $case)
  $created = Call POST '/api/cases' $t.Token $case @{ 'Idempotency-Key' = "entra-proof-$([guid]::NewGuid())" }
  Line 'POST /api/cases with an Idempotency-Key' $created
  $caseId = (Json $created).case.caseId
  Line 'GET /api/cases' (Call GET '/api/cases?limit=5' $t.Token)
  Line 'approve as a Representative' (Call POST "/api/cases/$caseId/proposals/1/approve" $t.Token @{ policyVersion = 1; proposalDigest = "sha256:$('0' * 64)" })
  Line 'operator work list as a Representative' (Call GET '/api/operator/work?state=poison' $t.Token)
  ''
  SetRoles 'Resolve.Representative.aurora', 'Resolve.Representative.borealis', 'Resolve.Approver.aurora'
  $t = Token "$ApiAppId/access_as_user"
  "## 2. Roles in two application tenants. Token roles: $($t.Roles)"
  Line 'GET /api/cases with roles in two tenants' (Call GET '/api/cases?limit=1' $t.Token)
  ''
  SetRoles 'Resolve.Representative.aurora', 'Resolve.Approver.aurora'
  $t = Token 'api://resolve-proof-a/access_as_user'
  "## 3. Representative and Approver (aurora). Token roles: $($t.Roles)"
  "- own case status after the deployed trigger ran: $(AwaitStatus $caseId $t.Token 'awaiting_approval')"
  $p = Json (Call GET "/api/cases/$caseId/proposals/1" $t.Token)
  Line 'approve my own case (separation of duties)' (Call POST "/api/cases/$caseId/proposals/1/approve" $t.Token @{ policyVersion = $p.policyRef.version; proposalDigest = $p.digest })
  if ($ApproveCaseId -ne '') {
    $p2 = Json (Call GET "/api/cases/$ApproveCaseId/proposals/1" $t.Token)
    Line "approve $ApproveCaseId (created by a different principal)" (Call POST "/api/cases/$ApproveCaseId/proposals/1/approve" $t.Token @{ policyVersion = $p2.policyRef.version; proposalDigest = $p2.digest })
    "- case status after approval and the deployed trigger: $(AwaitStatus $ApproveCaseId $t.Token 'credited')"
  }
  ''
  SetRoles 'Resolve.Representative.borealis'
  $t = Token 'api://resolve-proof-b/access_as_user'
  "## 4. Representative of the other tenant only. Token roles: $($t.Roles)"
  Line 'read the aurora case from the borealis tenant' (Call GET "/api/cases/$caseId" $t.Token)
  Line 'list cases (borealis)' (Call GET '/api/cases?limit=5' $t.Token)
}
finally {
  SetRoles $original
}
