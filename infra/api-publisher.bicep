targetScope = 'resourceGroup'

@description('Region of the existing demo application.')
param location string

@minLength(3)
@maxLength(12)
param namePrefix string = 'resolve-demo'

@description('Enable only after the application exists and a scoped role-assignment administrator approves its publication grants.')
param grantAccess bool = false

var suffix = uniqueString(resourceGroup().id)

resource app 'Microsoft.Web/sites@2024-11-01' existing = {
  name: '${namePrefix}-${suffix}'
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' existing = {
  name: '${namePrefix}-plan-${suffix}'
}

resource publisher 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-publisher-${suffix}'
  location: location
}

resource trust 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: publisher
  name: 'github-api-cd'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:jaydestro/cosmos-agentic-support-api:environment:azure-api-cd'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource publishAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantAccess) {
  name: guid(app.id, publisher.id, 'website-contributor')
  scope: app
  properties: {
    principalType: 'ServicePrincipal'
    principalId: publisher.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-1756-47ae-9be6-808fbbe84772')
  }
}

resource planRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantAccess) {
  name: guid(plan.id, publisher.id, 'plan-reader')
  scope: plan
  properties: {
    principalType: 'ServicePrincipal'
    principalId: publisher.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  }
}

output clientId string = publisher.properties.clientId
output functionName string = app.name
