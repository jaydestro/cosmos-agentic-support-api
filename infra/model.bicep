targetScope = 'resourceGroup'

@description('Region verified against the model catalog and subscription quota before provisioning.')
param location string

@minLength(3)
@maxLength(12)
param namePrefix string = 'resolve-demo'

var suffix = uniqueString(resourceGroup().id)

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${namePrefix}-model-${suffix}'
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: '${namePrefix}-model-${suffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource investigator 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: 'investigator'
  sku: {
    name: 'Standard'
    capacity: 10
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4.1-mini'
      version: '2025-04-14'
    }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output modelAccountName string = account.name
output modelEndpoint string = 'https://${account.name}.openai.azure.com'
output modelDeployment string = investigator.name
