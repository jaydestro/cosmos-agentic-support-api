import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapRoles } from '../../src/auth/principal.ts';
import { createAuthenticator } from '../../src/auth/verify.ts';
import type { AuthConfig } from '../../src/config/env.ts';
import { createMemoryLogger } from '../../src/telemetry/log.ts';
import { SEED_TENANTS } from '../../tools/seed/data/index.ts';
import { ACCOUNT_HINTS, findPersona, hintsFor, PERSONAS, roleClaims } from '../../web/src/personas.ts';
import { createTestIssuer } from '../support/tokens.ts';

const TENANTS = SEED_TENANTS.map((tenant) => tenant.tenantId);
const SCHEME = ['Bear', 'er'].join('');
const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

describe('test personas', () => {
  it('lists the six sign-ins in the order the console offers them', () => {
    assert.deepEqual(
      PERSONAS.map((persona) => persona.id),
      ['aurora-representative', 'aurora-approver', 'aurora-both', 'aurora-operator', 'borealis-representative', 'borealis-approver'],
    );
    assert.deepEqual(
      PERSONAS.map((persona) => persona.label),
      [
        'Aurora support representative',
        'Aurora approver',
        'Aurora representative and approver (one person)',
        'Aurora operator',
        'Borealis support representative',
        'Borealis approver',
      ],
    );
  });

  it('is not changeable at run time', () => {
    assert.ok(Object.isFrozen(PERSONAS));
    assert.ok(Object.isFrozen(ACCOUNT_HINTS));
  });

  it('gives each persona a distinct id, label and object id', () => {
    for (const key of ['id', 'label', 'oid'] as const) {
      assert.equal(new Set(PERSONAS.map((persona) => persona[key])).size, PERSONAS.length, key);
    }
  });

  it('uses object ids the API accepts, which differ in the first eight characters the console shows for another user', () => {
    for (const persona of PERSONAS) assert.match(persona.oid, GUID, persona.id);
    assert.equal(new Set(PERSONAS.map((persona) => persona.oid.slice(0, 8))).size, PERSONAS.length);
  });

  it('describes what each persona is for', () => {
    for (const persona of PERSONAS) assert.ok(persona.purpose.trim().length > 10, persona.id);
  });

  it('puts every persona in a seeded tenant, with roles in the order the service reports them', () => {
    const order = ['Representative', 'Approver', 'Operator'];
    for (const persona of PERSONAS) {
      assert.ok(TENANTS.includes(persona.tenantId), persona.id);
      assert.ok(persona.roles.length > 0, persona.id);
      assert.deepEqual(
        [...persona.roles],
        order.filter((role) => (persona.roles as readonly string[]).includes(role)),
        persona.id,
      );
    }
  });

  it('has exactly one persona that is both representative and approver, so separation of duties can be shown', () => {
    const both = PERSONAS.filter((persona) => persona.roles.includes('Representative') && persona.roles.includes('Approver'));
    assert.deepEqual(
      both.map((persona) => persona.id),
      ['aurora-both'],
    );
  });

  it('has a representative and an approver in each tenant, and an operator in aurora', () => {
    for (const tenantId of TENANTS) {
      for (const role of ['Representative', 'Approver'] as const) {
        assert.ok(
          PERSONAS.some((persona) => persona.tenantId === tenantId && persona.roles.includes(role)),
          `${tenantId} ${role}`,
        );
      }
    }
    assert.ok(PERSONAS.some((persona) => persona.tenantId === 'aurora' && persona.roles.includes('Operator')));
  });

  it('finds a persona by id', () => {
    assert.equal(findPersona('aurora-approver')?.label, 'Aurora approver');
    assert.equal(findPersona(null), undefined);
    assert.equal(findPersona(''), undefined);
    assert.equal(findPersona('nobody'), undefined);
    assert.equal(findPersona('constructor'), undefined);
    assert.equal(findPersona('__proto__'), undefined);
  });
});

describe('persona role claims', () => {
  it('names one role per tenant and role', () => {
    const claims = Object.fromEntries(PERSONAS.map((persona) => [persona.id, roleClaims(persona)]));
    assert.deepEqual(claims, {
      'aurora-representative': ['Resolve.Representative.aurora'],
      'aurora-approver': ['Resolve.Approver.aurora'],
      'aurora-both': ['Resolve.Representative.aurora', 'Resolve.Approver.aurora'],
      'aurora-operator': ['Resolve.Operator.aurora'],
      'borealis-representative': ['Resolve.Representative.borealis'],
      'borealis-approver': ['Resolve.Approver.borealis'],
    });
  });

  it('maps through the service role mapping to the persona tenant and roles', () => {
    for (const persona of PERSONAS) {
      assert.deepEqual(mapRoles(roleClaims(persona), TENANTS), { ok: true, tenantId: persona.tenantId, roles: [...persona.roles] }, persona.id);
    }
  });

  it('signs in through the real token validation as the principal it describes', async () => {
    const issuer = await createTestIssuer();
    const config: AuthConfig = {
      mode: 'test-idp',
      issuer: issuer.issuer,
      audiences: [issuer.audience],
      jwksUrl: 'http://127.0.0.1:1/jwks.json',
      directoryId: undefined,
    };
    const { logger } = createMemoryLogger();
    const authenticator = createAuthenticator(config, TENANTS, { logger, getKey: issuer.getKey() });
    for (const persona of PERSONAS) {
      const token = await issuer.mint({ oid: persona.oid, roles: roleClaims(persona) });
      assert.deepEqual(
        await authenticator.authenticate(`${SCHEME} ${token}`),
        { principalId: persona.oid.toLowerCase(), tenantId: persona.tenantId, roles: [...persona.roles] },
        persona.id,
      );
    }
  });
});

describe('account suggestions', () => {
  it('match the seeded accounts, in order, by id and name', () => {
    for (const tenant of SEED_TENANTS) {
      assert.deepEqual(
        hintsFor(tenant.tenantId).map((hint) => [hint.accountId, hint.name]),
        tenant.accounts.map((account) => [account.accountId, account.displayName]),
        tenant.tenantId,
      );
    }
  });

  it('stay within the tenant they are offered for', () => {
    for (const tenant of SEED_TENANTS) {
      for (const hint of hintsFor(tenant.tenantId)) assert.ok(hint.accountId.startsWith(`acct_${tenant.tenantId}_`), hint.accountId);
    }
  });

  it('describe a scenario for every account', () => {
    for (const tenantId of TENANTS) {
      for (const hint of hintsFor(tenantId)) assert.ok(hint.scenario.length > 10, hint.accountId);
    }
  });

  it('offers none for a tenant it does not know, including names inherited from Object.prototype', () => {
    for (const tenantId of ['', 'other', 'AURORA', 'constructor', '__proto__', 'toString']) {
      assert.deepEqual(hintsFor(tenantId), [], tenantId);
    }
  });

  it('are all fictional', () => {
    for (const tenantId of TENANTS) {
      for (const hint of hintsFor(tenantId)) assert.ok(hint.name.endsWith('(fictional)'), hint.name);
    }
  });
});
