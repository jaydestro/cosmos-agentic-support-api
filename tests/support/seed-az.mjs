#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setInterval } from 'node:timers';

const args = process.argv.slice(2);
const scenario = process.env.SEED_AZ_SCENARIO;
const path = process.env.SEED_AZ_TRACE;
appendFileSync(path, `${JSON.stringify(args)}\n`);
const option = (name) => args[args.indexOf(name) + 1];
const is = (...prefix) => prefix.every((value, index) => args[index] === value);
const groupId = '/subscriptions/sub-one/resourceGroups/resolve-test';
const accountName = 'resolve-demo-y4chtkiyxiv4k';
const accountId = `${groupId}/providers/Microsoft.DocumentDB/databaseAccounts/${accountName}`;
const identityName = option('--name');
const identityId = `${groupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/resolve-demo-seed-y4chtkiyxiv4k`;
const roleId = `${accountId}/sqlRoleDefinitions/seed-role`;
const item = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items';
const fail = (message) => {
  process.stderr.write(message);
  process.exit(1);
};
const hang = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(`${path}.pid`, String(child.pid));
  setInterval(() => {}, 1000);
};
let result;
if (is('group', 'show')) {
  result = { id: groupId, name: 'resolve-test' };
} else if (is('cosmosdb', 'show')) {
  result = {
    id: accountId, name: accountName, capabilities: [{ name: scenario === 'provisioned' ? 'Other' : 'EnableServerless' }],
    locations: scenario === 'multi-region' ? [{}, {}] : [{}],
    publicNetworkAccess: scenario === 'public' ? 'Enabled' : 'Disabled', disableLocalAuth: true,
  };
} else if (is('identity', 'show')) {
  result = {
    id: identityId.replace('resolve-demo-seed-y4chtkiyxiv4k', identityName),
    name: identityName, clientId: 'seed-client', principalId: 'seed-principal',
    tags: { project: 'resolve', purpose: scenario === 'wrong-tags' ? 'deployment' : 'reference-seeding' },
  };
} else if (is('network', 'vnet', 'subnet', 'show')) {
  result = {
    id: scenario === 'subnet-mismatch' ? `${option('--ids')}-other` : option('--ids'),
    delegations: scenario === 'no-delegation' ? [] : [{ serviceName: 'Microsoft.ContainerInstance/containerGroups' }],
  };
} else if (is('cosmosdb', 'sql', 'role', 'assignment', 'list')) {
  result = scenario === 'missing-grant' ? [] : [{
    principalId: 'seed-principal', roleDefinitionId: roleId,
    scope: `${accountId}/dbs/resolve/colls/${scenario === 'broad-scope' ? 'cases' : 'reference'}`,
  }];
  if (scenario === 'extra-grant') result.push({ ...result[0], scope: accountId });
} else if (is('cosmosdb', 'sql', 'role', 'definition', 'list')) {
  result = [{
    id: roleId, roleName: 'resolve-demo-reference-seeder', type: 'CustomRole',
    assignableScopes: [accountId],
    permissions: [{
      dataActions: [
        'Microsoft.DocumentDB/databaseAccounts/readMetadata',
        'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery',
        'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/readChangeFeed',
        `${item}/read`, `${item}/create`, ...(scenario === 'broad-role' ? [`${item}/*`] : []),
      ],
    }],
  }];
} else if (is('container', 'create')) {
  const tags = Object.fromEntries(args.slice(args.indexOf('--tags') + 1, args.indexOf('--environment-variables'))
    .map((tag) => tag.split('=')));
  writeFileSync(`${path}.container`, JSON.stringify({ tags, name: option('--name') }));
  if (scenario === 'create-hang') hang();
  else if (['create-failure', 'cleanup-failure', 'not-found', 'delayed-create', 'lookup-failure', 'foreign-tags'].includes(scenario)) {
    fail('ERROR: (ProvisioningFailed) original create error');
  }
} else if (is('container', 'show')) {
  const container = JSON.parse(readFileSync(`${path}.container`, 'utf8'));
  if (option('--name') !== container.name) fail('Unexpected container name');
  const query = option('--query');
  if (query === 'tags') {
    const cleanupLookups = readFileSync(path, 'utf8').split('"tags"').length - 1;
    if (scenario === 'not-found' || (scenario === 'delayed-create' && cleanupLookups === 1)) fail('ERROR: (ResourceNotFound) absent');
    if (scenario === 'lookup-failure') fail('ERROR: (AuthorizationFailed) cleanup lookup denied');
    result = {
      ...container.tags,
      ...(scenario === 'foreign-tags' ? { runId: 'another-invocation' } : {}),
      ...(scenario === 'foreign-source' ? { sourceCommit: 'another-source' } : {}),
      ...(scenario === 'foreign-manager' ? { managedBy: 'another-manager' } : {}),
    };
  } else if (query === 'identity') {
    result = {
      type: 'UserAssigned',
      userAssignedIdentities: {
        [identityId]: {},
        ...(scenario === 'extra-identity' ? { [`${identityId}-app`]: {} } : {}),
      },
    };
  } else if (scenario === 'show-hang') hang();
  else {
    result = scenario === 'provisioning' && !readFileSync(path, 'utf8').includes('"logs"')
      && readFileSync(path, 'utf8').split('containers[0]').length === 2
      ? null : { state: 'Terminated', exitCode: scenario.startsWith('seed-failure') ? 7 : 0 };
  }
} else if (is('container', 'delete')) {
  if (['cleanup-failure', 'delete-failure', 'seed-failure-cleanup'].includes(scenario)) fail('ERROR: (AuthorizationFailed) cleanup delete denied');
} else if (is('container', 'logs')) {
  if (scenario === 'seed-failure-logs') fail('ERROR: (AuthorizationFailed) logs denied');
  process.stdout.write('synthetic seed run 1 and repeat read-back complete');
} else {
  fail(`Unexpected fake Azure command: ${JSON.stringify(args)}`);
}
if (result !== undefined) process.stdout.write(JSON.stringify(result));
