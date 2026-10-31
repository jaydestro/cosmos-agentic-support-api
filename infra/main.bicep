targetScope = 'resourceGroup'

@description('Explicitly approved single Azure region. Check Flex, Cosmos DB serverless and quota availability before deployment.')
param location string

@description('Entra directory GUID; application tenant roles are defined separately in the app registration.')
@minLength(36)
@maxLength(36)
param entraTenantId string

@description('Exact audience expected in delegated API access tokens.')
param apiAudience string

@description('Public SPA app registration client GUID, not a secret.')
@minLength(36)
@maxLength(36)
param consoleClientId string

@description('Delegated scope exposed by the API app registration.')
param consoleApiScope string

@minLength(3)
@maxLength(12)
param namePrefix string = 'resolve'

@description('Optional EXISTING Azure OpenAI account in this resource group. Empty keeps deterministic demo mode.')
param modelAccountName string = ''
param modelEndpoint string = ''
param modelDeployment string = ''
param modelInputUsdPerMillionTokens string = ''
param modelOutputUsdPerMillionTokens string = ''
param modelPricingAsOf string = ''

@description('Only true after explicit paid-execution and numeric-limit approval. Does not create a model deployment.')
param liveModelApproved bool = false

var suffix = uniqueString(resourceGroup().id)
var manifest = loadJsonContent('./containers.json')
var accountName = '${namePrefix}-${suffix}'
var storageName = 'st${suffix}'
var metadata = 'Microsoft.DocumentDB/databaseAccounts/readMetadata'
var query = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery'
var changeFeed = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/readChangeFeed'
var item = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items'
var roles = [
  { label: 'reference-reader', actions: [metadata, query, changeFeed, '${item}/read'] }
  { label: 'case-writer', actions: [metadata, query, changeFeed, '${item}/read', '${item}/create', '${item}/replace'] }
  { label: 'provider-writer', actions: [metadata, query, changeFeed, '${item}/read', '${item}/create'] }
  { label: 'lease-writer', actions: [metadata, query, changeFeed, '${item}/*'] }
  { label: 'reference-seeder', actions: [metadata, query, changeFeed, '${item}/read', '${item}/create'] }
]

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-app-${suffix}'
  location: location
}

resource seedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-seed-${suffix}'
  location: location
}

resource model 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (modelAccountName != '') {
  name: modelAccountName
}

resource modelRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (modelAccountName != '') {
  name: guid(model!.id, appIdentity.id, 'model-inference')
  scope: model
  properties: {
    principalType: 'ServicePrincipal'
    principalId: appIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet-${suffix}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [
      {
        name: 'functions'
        properties: {
          addressPrefix: '10.42.1.0/24'
          delegations: [
            { name: 'flex', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
        }
      }
      {
        name: 'endpoints'
        properties: {
          addressPrefix: '10.42.2.0/27'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'seed-runner'
        properties: { addressPrefix: '10.42.3.0/27' }
      }
    ]
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: accountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [{ name: 'EnableServerless' }]
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 240
        backupRetentionIntervalInHours: 8
        backupStorageRedundancy: 'Local'
      }
    }
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: manifest.database
  properties: { resource: { id: manifest.database } }
}

resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [for container in manifest.containers: {
  parent: database
  name: container.name
  properties: {
    resource: union({
      id: container.name
      partitionKey: container.partitionKey
      indexingPolicy: container.indexingPolicy
    }, container.defaultTtl == null ? {} : { defaultTtl: container.defaultTtl })
  }
}]

resource definitions 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2024-11-15' = [for role in roles: {
  parent: cosmos
  name: guid(cosmos.id, role.label)
  properties: {
    roleName: '${namePrefix}-${role.label}'
    type: 'CustomRole'
    assignableScopes: [cosmos.id]
    permissions: [{ dataActions: role.actions }]
  }
}]

var grants = [
  { container: 'reference', role: 0, identity: 'app' }
  { container: 'cases', role: 1, identity: 'app' }
  { container: 'provider', role: 2, identity: 'app' }
  { container: 'leases', role: 3, identity: 'app' }
  { container: 'reference', role: 4, identity: 'seed' }
]

resource assignments 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = [for grant in grants: {
  parent: cosmos
  name: guid(cosmos.id, grant.identity, grant.container)
  properties: {
    principalId: grant.identity == 'app' ? appIdentity.properties.principalId : seedIdentity.properties.principalId
    roleDefinitionId: definitions[grant.role].id
    scope: '${cosmos.id}/dbs/${manifest.database}/colls/${grant.container}'
  }
  dependsOn: [containers]
}]

resource privateDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.documents.azure.com'
  location: 'global'
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDns
  name: '${namePrefix}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: network.id }
  }
}

resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${namePrefix}-cosmos-${suffix}'
  location: location
  properties: {
    subnet: { id: resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'endpoints') }
    privateLinkServiceConnections: [
      {
        name: 'cosmos'
        properties: {
          privateLinkServiceId: cosmos.id
          groupIds: ['Sql']
        }
      }
    ]
  }
}

resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'cosmos'
  properties: {
    privateDnsZoneConfigs: [{ name: 'cosmos', properties: { privateDnsZoneId: privateDns.id } }]
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    accessTier: 'Hot'
  }
}

resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'deployments'
  properties: { publicAccess: 'None' }
}

resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, appIdentity.id, 'host-blob-owner')
  scope: storage
  properties: {
    principalType: 'ServicePrincipal'
    principalId: appIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
  }
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-insights-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: true
    RetentionInDays: 30
  }
}

resource telemetryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, appIdentity.id, 'telemetry')
  scope: insights
  properties: {
    principalType: 'ServicePrincipal'
    principalId: appIdentity.properties.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: '${namePrefix}-plan-${suffix}'
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}

resource app 'Microsoft.Web/sites@2024-11-01' = {
  name: '${namePrefix}-${suffix}'
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    virtualNetworkSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'functions')
    siteConfig: {
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: concat([
        { name: 'RESOLVE_ENV', value: 'azure' }
        { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
        { name: 'COSMOS_DATABASE', value: manifest.database }
        { name: 'COSMOS_AUTH', value: 'managed-identity' }
        { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
        { name: 'COSMOS_CONNECTION__accountEndpoint', value: cosmos.properties.documentEndpoint }
        { name: 'COSMOS_CONNECTION__credential', value: 'managedidentity' }
        { name: 'COSMOS_CONNECTION__clientId', value: appIdentity.properties.clientId }
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__clientId', value: appIdentity.properties.clientId }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'ClientId=${appIdentity.properties.clientId};Authorization=AAD' }
        { name: 'AUTH_MODE', value: 'entra' }
        { name: 'ENTRA_TENANT_ID', value: entraTenantId }
        { name: 'ENTRA_AUDIENCE', value: apiAudience }
        { name: 'CONSOLE_ENTRA_CLIENT_ID', value: consoleClientId }
        { name: 'CONSOLE_API_SCOPE', value: consoleApiScope }
        { name: 'AGENT_MODE', value: modelAccountName == '' ? 'demo' : 'live' }
        { name: 'LIVE_MODEL_APPROVED', value: liveModelApproved ? 'true' : 'false' }
        { name: 'RESPONSE_VALIDATION', value: 'enforce' }
      ], modelAccountName == '' ? [] : [
        { name: 'LIVE_MODEL_ENDPOINT', value: modelEndpoint }
        { name: 'LIVE_MODEL_DEPLOYMENT', value: modelDeployment }
        { name: 'LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS', value: modelInputUsdPerMillionTokens }
        { name: 'LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS', value: modelOutputUsdPerMillionTokens }
        { name: 'LIVE_MODEL_PRICING_AS_OF', value: modelPricingAsOf }
      ])
    }
    functionAppConfig: {
      runtime: { name: 'node', version: '24' }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: appIdentity.id
          }
        }
      }
      scaleAndConcurrency: {
        alwaysReady: []
        instanceMemoryMB: 2048
        maximumInstanceCount: 40
        triggers: { http: { perInstanceConcurrency: 16 } }
      }
    }
  }
  dependsOn: [assignments, storageRole, telemetryRole, modelRole, dnsLink, dnsGroup]
}

output functionName string = app.name
output consoleUrl string = 'https://${app.properties.defaultHostName}'
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output appIdentityClientId string = appIdentity.properties.clientId
output seedIdentityClientId string = seedIdentity.properties.clientId
output seedIdentityPrincipalId string = seedIdentity.properties.principalId
output seedSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'seed-runner')
