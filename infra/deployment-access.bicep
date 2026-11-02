targetScope = 'resourceGroup'

@description('Administrator-only bootstrap for the existing deployment identity. Grants nothing outside this demo resource group.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'resolve'

@description('Allow the deployment identity to grant OpenAI User to the application identity for the live investigator.')
param enableLiveModel bool = false

var suffix = uniqueString(resourceGroup().id)
var contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var rbacAdministrator = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
var blobOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var metricsPublisher = '3913510d-42f4-4e42-8a64-420c390055eb'
var openAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
var allowedRoleIds = enableLiveModel ? '${blobOwner}, ${metricsPublisher}, ${openAiUser}' : '${blobOwner}, ${metricsPublisher}'

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${namePrefix}-app-${suffix}'
}

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${namePrefix}-deploy-${suffix}'
}

resource resourceAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentity.id, contributor)
  properties: {
    principalType: 'ServicePrincipal'
    principalId: deployIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributor)
  }
}

resource restrictedAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentity.id, rbacAdministrator)
  properties: {
    principalType: 'ServicePrincipal'
    principalId: deployIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministrator)
    conditionVersion: '2.0'
    condition: replace(replace('''
      (
        (!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'}))
        OR
        (
          @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {__ALLOWED_ROLE_IDS__}
          AND
          @Request[Microsoft.Authorization/roleAssignments:PrincipalId] GuidEquals __APP_PRINCIPAL_ID__
        )
      )
      AND
      (
        (!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'}))
        OR
        (
          @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {__ALLOWED_ROLE_IDS__}
          AND
          @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] GuidEquals __APP_PRINCIPAL_ID__
        )
      )
      ''', '__ALLOWED_ROLE_IDS__', allowedRoleIds), '__APP_PRINCIPAL_ID__', appIdentity.properties.principalId)
  }
}
