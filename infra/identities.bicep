targetScope = 'resourceGroup'

@description('Approved region for the identity-only bootstrap.')
param location string

@minLength(3)
@maxLength(12)
param namePrefix string = 'resolve'

var suffix = uniqueString(resourceGroup().id)

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-app-${suffix}'
  location: location
  tags: { project: 'resolve', purpose: 'application' }
}

resource seedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-seed-${suffix}'
  location: location
  tags: { project: 'resolve', purpose: 'reference-seeding' }
}

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-deploy-${suffix}'
  location: location
  tags: { project: 'resolve', purpose: 'deployment' }
}

resource githubTrust 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-azure-demo'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:jaydestro/cosmos-agentic-support-api:environment:azure-demo'
    audiences: ['api://AzureADTokenExchange']
  }
}

output appIdentityName string = appIdentity.name
output appIdentityClientId string = appIdentity.properties.clientId
output appIdentityPrincipalId string = appIdentity.properties.principalId
output seedIdentityName string = seedIdentity.name
output seedIdentityClientId string = seedIdentity.properties.clientId
output seedIdentityPrincipalId string = seedIdentity.properties.principalId
output deployIdentityName string = deployIdentity.name
output deployIdentityClientId string = deployIdentity.properties.clientId
output deployIdentityPrincipalId string = deployIdentity.properties.principalId
